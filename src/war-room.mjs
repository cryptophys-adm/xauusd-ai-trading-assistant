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
// Advisory only: stances are discussion positions, never orders. Agents speak on the room agent
// model, the moderator on the moderator model, each with its own fallback (2026-11-07).
// Behind WAR_ROOM_ENABLED; when on, it replaces the legacy live room and the per-H1 HUD
// agents (owner decision: their budget moves here).
import { chatMessages } from "./model-text.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";
import { HUD_NAMES, calibrationCounts, calibrationNote, calibratedLines, hudAgentsIn } from "./hud-reading.mjs";
import { loadHudSnapshot, hudReadings } from "./hud-store.mjs";
import { BUS_DEFAULT_MODEL, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { newsDeskEvidence } from "./news-daily.mjs";
import { macroDeskEvidence } from "./macro-room.mjs";
import { matchRebuts } from "./rebut-names.mjs";
import { buildCrowdLine, finalEntries, crowdRule, roomReputation, quorumAllows, quorumRule } from "./reputation.mjs";
import { agentReputation, sessionOf } from "./outcome-scoring.mjs";
import { learnedBlock, learnedPackInfo, learnedKnowledgeEnabled } from "./learned-knowledge.mjs";
import { shadowKnowledgeEnabled, shadowItems, planShadowCalls, runShadowCalls } from "./shadow-knowledge.mjs";
import { effectiveLearnedPack } from "./learned-live.mjs";
import { roomWeighting } from "./weighting.mjs";
import { chartDeskReading, chartDeskLabel } from "./timeframe-desk.mjs";
import { projectionReading } from "./projection-agent.mjs";
import { readPatternCalibration } from "./pattern-calibration.mjs";
import {
  ROOM_STANCES, ensureThreadSchema, isFifteenMinuteClose, liveEvidence, m15KeyForClose, buildLiveRoomTask,
  hudEvidenceLines, rowToThreadMessage, validateRoomModerator, threadInternals
} from "./agent-threads.mjs";

const FIFTEEN_MINUTES_MS = 900_000;
const { runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, ROOM_RULES_INDEPENDENT, clip, inUnit, parseJson } = threadInternals;

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
  news: { name: "News Analyst", role: "the fundamental news of the last 24 hours: the daily bias for gold and the headlines behind it" },
  technical: { name: "Technical Analyst", role: "price action only: the closed 15m candles" },
  risk: { name: "Risk Manager", role: "risk only: the volatility of the 15m chart, the 15m Prophet R38 confirmation and what would invalidate a move" },
  projection: { name: "Projection Agent", role: "where a move projects on the 15m chart: Fibonacci, the probability cone, trendlines and the chart patterns, each pattern with its record on gold" }
});
/** Retired 2026-11-09 (independent rooms): kept only to name the agent in stored rooms. */
const RETIRED_DESK_NAMES = Object.freeze({ htf: "Higher-Timeframe Desk" });

/**
 * Owner rule (2026-11-05): no confirmation, no entry. A BUY needs a confirmed buy signal from the
 * H1 Prophet R38 or a VERIFIED 5m Prophet R38 confirmation candle; a SELL needs a confirmed sell.
 * Owner report 2026-11-09: the H1 Prophet R38 setup still READY counts as the H1 confirmation
 * (the confirmation passed within the setup's confirmation window and the cycle alignment holds).
 */
export function entryAllowed(stance, confirmations) {
  if (stance !== "BUY" && stance !== "SELL") return true;
  const side = stance === "BUY" ? "buy" : "sell";
  const h1 = confirmations?.h1_prophet_r38?.[`${side}_confirmed`] === true || confirmations?.h1_prophet_r38?.[`${side}_setup_ready`] === true;
  const m5 = confirmations?.m5_prophet_r38?.verified === true && confirmations.m5_prophet_r38[`${side}_confirmed`] === true;
  return h1 || m5;
}

export const SUPPORT_RULE = "A BUY or SELL conclusion also needs at least one agent on the bus or in the Consensus Discussion holding that stance: a confirmation alone never overrules the whole room.";

export const NO_CONFIRMATION_RULE =
  "Rule: no confirmation, no entry. BUY needs a confirmed buy signal (the H1 Prophet R38 confirmation on the closed bar, or its BUY setup still READY: the confirmation passed within the setup's confirmation window and the bullish cycle alignment holds; or a VERIFIED 5m Prophet R38 confirmation candle); SELL needs the confirmed sell signal or the SELL setup READY. Without either the stance is WAIT, or HOLD / CLOSE for a position already open.";

/** Names of desks that earlier rooms used, so their stored messages still read by name. */
const LEGACY_DESK_NAMES = Object.freeze({ h1: "H1 Desk" });

export function agentName(id) {
  if (DESK_AGENTS[id]) return DESK_AGENTS[id].name;
  if (LEGACY_DESK_NAMES[id]) return LEGACY_DESK_NAMES[id];
  if (RETIRED_DESK_NAMES[id]) return RETIRED_DESK_NAMES[id];
  if (HUD_NAMES[id]) return HUD_NAMES[id];
  return id === "moderator" ? "Moderator" : String(id);
}

const OPENING_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { agent: { type: "string" }, stance: { type: "string", enum: [...ROOM_STANCES] }, bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] }, confidence: { type: "number" }, claim: { type: "string" }, metrics: { type: "array", items: { type: "string" } } },
  required: ["agent", "stance", "bias", "confidence", "claim", "metrics"]
});
const REBUTTAL_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { agent: { type: "string" }, stance: { type: "string", enum: [...ROOM_STANCES] }, bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] }, confidence: { type: "number" }, rebuts: { type: "array", items: { type: "string" } }, argument: { type: "string" }, metrics: { type: "array", items: { type: "string" } } },
  required: ["agent", "stance", "bias", "confidence", "rebuts", "argument", "metrics"]
});
const CONCLUSION_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  properties: { stance: { type: "string", enum: [...ROOM_STANCES] }, bias: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL"] }, confidence: { type: "number" }, summary: { type: "string" }, reasons: { type: "array", items: { type: "string" } }, dissent: { type: "array", items: { type: "string" } }, metrics: { type: "array", items: { type: "string" } } },
  required: ["stance", "bias", "confidence", "summary", "reasons", "dissent", "metrics"]
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

/**
 * Independence (owner decisions 2026-11-09): every agent speaks only from its own data on its own
 * timeframe, never names another agent and never uses another timeframe's room or decision; it says
 * which metrics it decided from. The Consensus Discussion stays inside each timeframe's room, over an
 * anonymous bus: each statement is shown as "#n" with its metrics, never with the agent's name.
 */
export const INDEPENDENCE_RULE = 'Independence: speak only from YOUR DATA, on this timeframe only. Never name or quote another agent or role, and never use another timeframe\'s room, desk or decision. Say in "metrics" which metrics you decided from (one to four, in plain words, for example "the 14-bar average range" or "the Prophet R38 buy confirmation"), and argue from those metrics.';
export const METRICS_MAX = 4;

/**
 * Pure: recovers a "metrics" list that a model wrote INSIDE its text field (production 2026-11-09,
 * 10:00-12:00 UTC: claims ending in `","metrics":["...", ...]}` plus stray tokens such as
 * `<|file_separator|>`), and cuts the text where the leaked field began. Returns true when repaired.
 */
export function repairLeakedMetrics(o, key) {
  if (!o || typeof o !== "object" || Array.isArray(o.metrics) || typeof o[key] !== "string") return false;
  const m = /\\*"\s*,\s*\\*"metrics\\*"\s*:\s*\[([\s\S]*?)\]/.exec(o[key]);
  if (!m) return false;
  const items = [...m[1].matchAll(/\\*"((?:[^"\\]|\\(?!"))+?)\\*"/g)].map((x) => x[1].trim()).filter(Boolean);
  if (!items.length) return false;
  o.metrics = items;
  o[key] = o[key].slice(0, m.index).replace(/\s+$/, "");
  return true;
}

/** Strips trailing model control tokens (`<|...|>`) and dangling JSON from a text field. */
export function stripModelTokens(text) {
  if (typeof text !== "string") return text;
  return text.replace(/\s*<\|[a-z_]+\|>[\s\S]*$/i, "").replace(/\s*[{\[]\s*"?\s*$/, "").trim();
}

/**
 * The metrics an agent decided from when its answer named none even after the correction: its own
 * data source (owner decisions 2026-11-09 allow an indicator as a metric, for example "the Prophet
 * R38 buy confirmation"); desks get their data in plain words, never a role name. The message is
 * marked metrics_inferred, so compliance (and Aether) still sees that the model left it out.
 */
const INFERRED_METRICS = Object.freeze({
  technical: ["the closed candles and moving averages"], risk: ["volatility and event risk"], news: ["the latest news analysis"],
  projection: ["the chart patterns, Fibonacci levels and trendlines"],
  m15: ["the 15-minute trend and key levels"], h1: ["the 1-hour trend and key levels"], h4: ["the 4-hour trend and key levels"], d1: ["the daily trend and key levels"],
  moderator: ["the room's weighted bias"]
});
export function inferredMetrics(agent) {
  if (INFERRED_METRICS[agent]) return [...INFERRED_METRICS[agent]];
  const name = agentName(agent);
  return [name && name !== agent ? `the ${name.replace(/^the\s+/i, "")} readings` : "this timeframe's own data"];
}

/** Normalises an answer's text before any check: recovers leaked metrics and strips model tokens. */
export function normalizeAnswerText(o) {
  if (!o || typeof o !== "object") return o;
  if (!Array.isArray(o.metrics)) for (const key of ["claim", "argument", "summary"]) if (repairLeakedMetrics(o, key)) break;
  for (const key of ["claim", "argument", "summary"]) if (typeof o[key] === "string") o[key] = stripModelTokens(o[key]);
  return o;
}

/** Pure: the errors of an answer's "metrics" list (1 to 4 plain-language entries). */
export function metricsErrors(o) {
  if (!o || typeof o !== "object") return [];
  normalizeAnswerText(o);
  if (!Array.isArray(o.metrics)) return ["metrics_missing"];
  o.metrics = o.metrics.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim().slice(0, 80)).slice(0, METRICS_MAX);
  if (!o.metrics.length) return ["metrics_missing"];
  return o.metrics.flatMap((m) => naturalLanguageErrors(m));
}

/** A role name (an agent that is a person-like desk), as opposed to an indicator's name. */
const ROLE_NAME = /\b(analyst|manager|desk|moderator|agent)\b/i;
/** Speech, opinion and possession: what turns an indicator's name into a reference to the agent. */
const ACTOR_AFTER = "(?:'s\\s+(?:view|argument|claim|point|case|call|stance|opinion)|\\s+(?:\\w+\\s+){0,2}?(?:says|said|argues|argued|claims|claimed|thinks|believes|suggests|suggested|warns|warned|agrees|agreed|disagrees|notes|noted|insists|wants|is right|is wrong|agent|desk))";
const ACTOR_BEFORE = "(?:according to|as|with|unlike|agree with|disagree with|per)\\s+(?:the\\s+)?";

/**
 * Pure: "names_an_agent" when `text` refers to another agent (whole words, any case).
 * - A role name (Risk Manager, News Analyst, a Desk, the Moderator) never appears.
 * - Most agents carry their indicator's name (Supertrend, Prophet, Order Blocks), which is also a
 *   metric the owner allows ("the Prophet R38 buy confirmation"). Such a name counts only when it
 *   is used as an actor: "Supertrend says", "the Prophet's view", "according to Order Blocks".
 *   Production 2026-11-09 lost valid room answers that cited "the Supertrend has held" as a metric.
 */
export function namesErrors(text, names = []) {
  if (typeof text !== "string" || !text) return [];
  const t = text.toLowerCase();
  for (const n of names) {
    const full = String(n || "").trim();
    const name = full.toLowerCase().replace(/^the\s+/, "").replace(/\s*\([^)]*\)\s*$/, "");
    if (name.length < 4) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bound = (s) => new RegExp(`(^|[^a-z0-9])${s}([^a-z0-9]|$)`);
    if (ROLE_NAME.test(full)) { if (bound(esc).test(t)) return ["names_an_agent"]; continue; }
    if (new RegExp(`(^|[^a-z0-9])${esc}${ACTOR_AFTER}`).test(t) || new RegExp(`${ACTOR_BEFORE}${esc}([^a-z0-9]|$)`).test(t)) return ["names_an_agent"];
  }
  return [];
}

/** The names an agent may not write: every other agent of the room (its own HUD name is its data source). */
export function forbiddenNamesFor(agent, roster, nameOf = agentName) {
  return (roster || []).filter((id) => id !== agent).map(nameOf);
}

/** The desk role names nobody writes (the moderator and the Reasoner cite metrics, not roles). */
export function deskNames(nameOf = agentName, ids = Object.keys(DESK_AGENTS)) {
  return [...ids.map(nameOf), "Higher-Timeframe Desk", "Moderator"];
}

/** Anonymous bus references (#1, #2, ...) in roster order, and back. */
export function busRefs(roster) {
  const toRef = new Map(), toId = new Map();
  (roster || []).forEach((id, i) => { toRef.set(id, `#${i + 1}`); toId.set(`#${i + 1}`, id); });
  return { toRef, toId, idOf: (r) => toId.get(String(r ?? "").trim()) ?? toId.get("#" + String(r ?? "").trim().replace(/^#/, "")) ?? r };
}

/** Calibration cap (owner decision A): a HUD agent with no verified statement speaks at <= 0.4. */
export const UNCALIBRATED_CONFIDENCE_CAP = 0.4;

export function validateOpening(o, agent, { verifiedLines = null, forbiddenNames = [] } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  normalizeAnswerText(o);
  const errors = [];
  if (!sameAgent(o.agent, agent)) errors.push("agent_mismatch");
  else o.agent = agent;
  if (verifiedLines === 0 && inUnit(o.confidence)) o.confidence = Math.min(o.confidence, UNCALIBRATED_CONFIDENCE_CAP);
  if (!ROOM_STANCES.includes(o.stance)) errors.push("stance_invalid");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.claim !== "string" || !o.claim.trim()) errors.push("claim_missing");
  else errors.push(...naturalLanguageErrors(o.claim), ...namesErrors(o.claim, forbiddenNames));
  errors.push(...metricsErrors(o));
  // A missing bias falls back to the action's direction; a malformed one is an error.
  if (o.bias == null || o.bias === "") o.bias = biasOfStance(o.stance);
  else if (ROOM_BIASES.includes(String(o.bias).trim().toUpperCase())) o.bias = String(o.bias).trim().toUpperCase();
  else errors.push("bias_invalid");
  return { valid: errors.length === 0, errors };
}

/** Rebuttal targets as bus ids: an agent's id or display name in any spelling with the same slug (src/rebut-names.mjs). */
export function normalizeRebuts(rebuts, busAgents) {
  return matchRebuts(rebuts, busAgents, agentName);
}

/**
 * A rebuttal names the bus agents it rebuts. Two cases may name nobody:
 * - In a unanimous room the Risk Manager stress-tests the consensus (preview-e2e: a unanimous
 *   WAIT room left it no one to rebut, and it answered rebuts: []).
 * - A dissenter the bus persuaded concedes: its stance differs from its own opening (`ownStance`).
 *   Production wrote rebuts [itself] or [] for every such concession and lost it as
 *   rebuts_invalid; it is now kept, with its own id dropped and `conceded: true`.
 */
export function validateRebuttal(o, agent, busAgents, { unanimous = false, ownStance = null, ownBias = null, forbiddenNames = [], refs = null } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  normalizeAnswerText(o);
  agentIdsToNames(o, busAgents);
  // The anonymous bus (#n) maps back to agent ids.
  if (refs && Array.isArray(o.rebuts)) o.rebuts = o.rebuts.map(refs.idOf);
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
  else errors.push(...naturalLanguageErrors(o.argument), ...namesErrors(o.argument, forbiddenNames));
  errors.push(...metricsErrors(o));
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

/**
 * Agent ids in a moderator's text are written as the agents' names (preview-e2e 2026-11-07: the
 * gpt-oss-120b moderator wrote "trade_management", which the natural-language rule rejects as a
 * field name). Only ids of agents on the bus are replaced; any other code-like text still fails.
 */
export function agentIdsToNames(o, ids, nameOf = agentName) {
  if (!o || typeof o !== "object") return o;
  const swap = (t) => {
    if (typeof t !== "string") return t;
    let out = t;
    for (const id of ids || []) if (/_/.test(id)) out = out.replace(new RegExp(`\\b${id}\\b`, "g"), nameOf(id));
    return out;
  };
  for (const k of ["summary", "argument", "claim"]) if (typeof o[k] === "string") o[k] = swap(o[k]);
  if (Array.isArray(o.reasons)) o.reasons = o.reasons.map(swap);
  return o;
}

export function validateConclusion(o, h1Decision, busAgents, confirmations = null, { supportStances = null, supportBiases = null, roomBias = "NEUTRAL", crowd = undefined, forbiddenNames = null, refs = null } = {}) {
  if (forbiddenNames) normalizeAnswerText(o);
  agentIdsToNames(o, busAgents);
  if (refs && o && typeof o === "object" && Array.isArray(o.dissent)) o.dissent = o.dissent.map(refs.idOf);
  // At most three reasons are kept (a fourth is dropped, not a reason to lose the conclusion).
  if (o && typeof o === "object" && Array.isArray(o.reasons) && o.reasons.length > 3) o.reasons = o.reasons.filter(r => !(typeof r === "string" && !r.trim())).slice(0, 3);
  const base = validateRoomModerator(o, h1Decision);
  const errors = [...base.errors, ...conclusionBiasErrors(o, { supportBiases, roomBias })];
  if (o && typeof o === "object" && confirmations && !entryAllowed(o.stance, confirmations)) errors.push("entry_without_confirmation");
  // The independent 15m room (owner decision 2026-11-09) is judged by its own quorum, like every room.
  if (o && typeof o === "object" && crowd !== undefined && !quorumAllows(o.stance, crowd)) errors.push("entry_without_quorum");
  if (o && typeof o === "object" && !stanceSupported(o.stance, supportStances)) errors.push("stance_without_support");
  if (o && typeof o === "object" && forbiddenNames) {
    errors.push(...namesErrors(o.summary, forbiddenNames), ...(Array.isArray(o.reasons) ? o.reasons.flatMap((r) => namesErrors(r, forbiddenNames)) : []));
    errors.push(...metricsErrors(o));
  }
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
  "Never give entry, stop loss, take profit or position size: price levels are not part of a room."
].join("\n");

function openingMessages(agent, data, learned = null, note = null) {
  const desk = DESK_AGENTS[agent];
  const riskRule = agent === "risk" ? ["Judge the risk of every possible entry from your data: the 15m volatility, the 15m Prophet R38 confirmation and what would invalidate the move, and say plainly whether you would take it."] : [];
  const who = desk
    ? `You are the ${desk.name} in the XAUUSD Live War Room, which meets at every 15m candle close. Your only role: ${desk.role}.`
    : `You are ${HUD_NAMES[agent]}, one agent per Pine HUD, in the XAUUSD Live War Room, which meets at every 15m candle close. You speak only about the ${HUD_NAMES[agent]} HUD on the 15m candle that just closed. Lean on the statements marked verified by parity or computed from verified bars. The readers already see your calibration status once, next to your name: never mention calibration, verification or comparators in your claim. When every statement is not yet calibrated, keep your confidence at or below ${UNCALIBRATED_CONFIDENCE_CAP}.`;
  return chatMessages([
    who,
    ROOM_RULES_INDEPENDENT,
    ROOM_RULES,
    INDEPENDENCE_RULE,
    ...riskRule,
    "This is your opening on the communication bus: one claim from your own data only.",
    BIAS_RULE,
    // Aether A7 shadow arm only (src/shadow-knowledge.mjs): a learned note under test, never in a live opening.
    ...(note ? [note] : []),
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"claim":"<= ${CLAIM_MAX - 40} chars","metrics":["<the metrics you decided from, plain words>"]}`,
    "YOUR DATA:",
    JSON.stringify(data),
    // Aether A9 (src/learned-knowledge.mjs): the bundled learned notes for this agent, only with LEARNED_KNOWLEDGE_ENABLED.
    ...(learned ? [learned] : [])
  ]);
}

/** The anonymous bus (owner decision 2026-11-09): "#n", stance, bias, confidence, evidence, metrics, claim; never a name. */
export function anonymousBus(bus, refs) {
  return bus.map((b) => ({ ref: refs.toRef.get(b.id) ?? null, stance: b.stance, bias: b.bias ?? null, confidence: b.confidence, evidence: b.evidence ?? null, metrics: b.metrics ?? [], claim: b.claim }));
}

function rebuttalMessages(agent, own, bus, unanimous, roomBias = null) {
  const risk = agent === "risk" ? ["As the Risk Manager, challenge every statement on the bus that proposes BUY or SELL: which metric would invalidate it on this chart."] : [];
  return chatMessages([
    `You are ${agentName(agent)} in the Consensus Discussion of the XAUUSD Live War Room (15m). The bus below holds every opening of this bar, anonymously.`,
    ROOM_RULES_INDEPENDENT,
    ROOM_RULES,
    INDEPENDENCE_RULE,
    ...risk,
    ...(roomBias ? [biasSplitText(roomBias)] : []),
    unanimous
      ? "The bus is unanimous. Stress-test the consensus: challenge the statement most likely to be wrong, put its reference in rebuts, and say which metric would invalidate the consensus. Add only new reasoning from your own metrics; never restate a claim."
      : "Rebut the statements you disagree with and put their references (#n) in rebuts. Argue from your own metrics against theirs; never restate your opening or another claim. You may change your stance or your bias if the bus convinced you: then put the references of the statements that convinced you in rebuts (or leave it empty).",
    "Refer to bus statements only by their # reference, and only in the rebuts field: the argument names metrics, never an agent or a role.",
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"rebuts":["#n"],"argument":"<= ${ARGUMENT_MAX - 40} chars","metrics":["<the metrics you argue from>"]}`,
    "YOUR OPENING: " + JSON.stringify({ stance: own.stance, bias: own.bias ?? null, confidence: own.confidence, metrics: own.metrics ?? [], claim: own.claim }),
    "COMMUNICATION BUS (ref, stance, bias, confidence, evidence, metrics, claim):",
    JSON.stringify(bus)
  ]);
}

function conclusionMessages(bus, debate, crowd = null, learned = null) {
  return chatMessages([
    "You are the moderator of the XAUUSD Live War Room (15m). The Consensus Discussion is closed. Write the conclusion for the main panel from this timeframe's statements only.",
    ...(crowd ? [crowdRule(crowd)] : []),
    ROOM_RULES_INDEPENDENT,
    ROOM_RULES,
    (crowd ? quorumRule(crowd) : "There is no crowd line, so there is no quorum: the conclusion is WAIT, HOLD or CLOSE.") + " The conclusion obeys it.",
    SUPPORT_RULE,
    DECISION_BIAS_RULE + " A BULLISH or BEARISH bias needs at least one statement holding it.",
    "Weigh statements by their metrics and their evidence, not by their number: a statement built on data verified by parity, or computed from verified bars, outweighs one built on uncalibrated readings (each entry states which). No repetition: the summary states the conclusion once, each reason adds something new. In the summary and reasons name the metrics that decided, never an agent or a role; dissent lists the # references of statements whose stance or bias still differs from yours. Never discuss calibration itself.",
    `Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"summary":"<= 360 chars","reasons":["<= 160 chars", "at most 3"],"dissent":["#n"],"metrics":["<the metrics that decided>"]}`,
    "COMMUNICATION BUS:",
    JSON.stringify(bus),
    "CONSENSUS DISCUSSION:",
    JSON.stringify(debate),
    ...(learned ? [learned] : [])
  ]);
}

/** Each agent's own data on the 15m chart only (owner decision 2026-11-09: no other timeframe, no other agent). */
/** The cached 15m series of the feed (the Projection Agent reads the last 60 closed bars). */
async function seriesOf15(env) {
  try {
    const r = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|15m")) || "null");
    return Array.isArray(r?.candles) ? r.candles : [];
  } catch { return []; }
}

function agentData(agent, evidence, hud, confirmations, desk15, projection = null) {
  switch (agent) {
    case "projection": return projection ?? { available: false };
    case "m15": return { timeframe: "15 minutes", reading: desk15.reading, approved_by_parity: desk15.approved_by_parity };
    case "news": return evidence.news ? { window: evidence.news.window ?? "the latest hourly batch", consensus: evidence.news.consensus, confidence: evidence.news.confidence, summary: evidence.news.summary, reasons: evidence.news.reasons, counts: evidence.news.counts, headlines: evidence.news.headlines } : { available: false, note: "no news consensus yet" };
    case "technical": return { candles_15m: evidence.m15.candles };
    case "risk": {
      const c = evidence.m15.candles;
      const ranges = c.map(x => Math.round((x.h - x.l) * 100) / 100);
      return { candles_15m: c, ranges_15m: ranges, confirmations };
    }
    default: return { hud: HUD_NAMES[agent], timeframe: "15 minutes", reading: hudEvidenceLines(hud?.readings?.[agent]) };
  }
}

/** The 15m chart's own Prophet R38 confirmation and setup state, from the 15m desk reading. */
function m15Confirmations(desk15) {
  return { chart_prophet_r38: { buy_confirmed: desk15?.buy_confirmed === true, sell_confirmed: desk15?.sell_confirmed === true, buy_setup_ready: desk15?.buy_setup_ready === true, sell_setup_ready: desk15?.sell_setup_ready === true, approved_by_parity: desk15?.approved_by_parity === true, source: desk15?.available ? "the local Prophet R38 record of this 15m bar" : "not available" } };
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
  // Owner decisions 2026-11-09: the room is independent of every other timeframe. It reads the closed
  // 15m candles, its own 15m HUD snapshot and local records and the news; never the H1 chain, the 1H
  // room or the 5m lane. (liveEvidence still builds the 15m candles from the 5m bars of the feed.)
  const { evidence } = live;
  // News Daily (owner decision 2026-11-06): the News Analyst reads the last 24 hours when present.
  const daily = await newsDeskEvidence(db);
  if (daily) evidence.news = daily;

  let hud = null, plane = null;
  try {
    const key15 = m15KeyForClose(barTime);
    const carried = task.hud && typeof task.hud === "object" && task.hud.candle_key === key15 ? task.hud : null;
    const snapshot = carried || await loadHudSnapshot(env, { timeframe: "15", candleKey: key15 });
    plane = snapshot?.chart_plane ?? null;
    hud = snapshot ? await hudReadings(env, snapshot) : null;
  } catch { hud = null; }
  // The Projection Agent (owner 2026-11-12): the 15m chart's patterns and projection levels, no price.
  let projection = null;
  try {
    const closeMs = Date.parse(barTime);
    const bars15 = (await seriesOf15(env)).filter((b) => Date.parse(b.close_time) <= closeMs);
    projection = projectionReading({ bars: bars15, plane, calibration: await readPatternCalibration(env), timeframe: "15 minutes" });
  } catch { projection = null; }
  // The 15m Desk: the 15m local records of the candle that just closed (owner decision 2026-11-06).
  let desk15 = { available: false, reading: [], approved_by_parity: false };
  try { desk15 = await chartDeskReading(env, m15KeyForClose(barTime)); } catch { /* no desk this bar */ }
  const confirmations = m15Confirmations(desk15);
  const roster = [...(desk15.available ? ["m15"] : []), "news", "technical", "risk", ...(projection?.available ? ["projection"] : []), ...hudAgentsIn("M15").filter(id => hud?.readings?.[id]?.available)];
  const refs = busRefs(roster);
  // Evidence status, shown once per agent (owner decision A): no agent repeats it in its text.
  const calibration = Object.fromEntries(roster.map(id => {
    const lines = hud?.readings?.[id]?.lines;
    if (Array.isArray(lines)) return [id, calibrationCounts(lines)];
    if (id === "m15") return [id, { label: chartDeskLabel("15m", desk15) }];
    if (id === "technical" || id === "risk" || id === "projection") return [id, { label: "closed 15m bars" }];
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
  // Aether A9 in the 15m room too (owner 2026-11-13: "strengthen autonomous learning & knowledge looping"):
  // the bundled learned notes per agent, chart 15 and the bar's session; none unless LEARNED_KNOWLEDGE_ENABLED.
  const learnedCtx = { chart: "15", session: sessionOf(Date.parse(barTime)) };
  // The bundled pack plus the notes promoted autonomously (src/learned-live.mjs); read only when the notes are on.
  const learnedPack = learnedKnowledgeEnabled(env) ? await effectiveLearnedPack(env) : undefined;
  const learnedFor = (agent) => learnedBlock(env, { agent, ...learnedCtx, pack: learnedPack });
  if (!existing.has("brief")) {
    await writeMessage(db, { ...base("brief", "system"), ts: new Date(clock()).toISOString(), status: "info", body: { roster, calibration, confirmations, independent: true, m15_close: evidence.m15.candles.at(-1) ?? null, news: evidence.news,
      ...(learnedKnowledgeEnabled(env) ? { learned_pack: learnedPackInfo(env, { roster, ...learnedCtx, pack: learnedPack }) } : {}) } });
  }

  // One budget for the bar, shared by every parallel step (and its correction call).
  const roomEnv = env;
  const maxPerHour = Number(env.WAR_ROOM_MAX_CALLS_PER_HOUR ?? 136);
  let remaining = 0;
  try { remaining = (Number.isFinite(maxPerHour) ? maxPerHour : 0) - (await callsInLastHour(db, clock(), "warroom")); } catch { remaining = 0; }
  let calls = 0;
  const phase = (ms) => {
    const deadline = clock() + ms;
    const runState = { primaryError: null };
    const budgetOk = async () => clock() < deadline && remaining-- > 0;
    return (stepBase, opts) => { calls += 1; return runStep(roomEnv, db, stepBase, { inferMetrics: (b) => inferredMetrics(b?.agent), ...opts, deadline, clock, runState, budgetOk }); };
  };

  // Phase 1: the communication bus.
  const open = phase(WAR_ROOM_OPENING_MS);
  const openings = await Promise.all(roster.map(agent => {
    const prior = existing.get("open:" + agent);
    if (prior?.status === "ok") return prior;
    return open(base("open:" + agent, agent), {
      messages: openingMessages(agent, agentData(agent, evidence, hud, confirmations, desk15, projection), learnedFor(agent)), schemaName: "war_room_opening", schema: OPENING_SCHEMA,
      // An unapproved 15m chain speaks like any uncalibrated agent: at 0.4 or lower.
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateOpening(o, agent, { verifiedLines: agent === "m15" ? (desk15.approved_by_parity ? null : 0) : calibration[agent]?.total_lines == null ? null : calibratedLines(calibration[agent]), forbiddenNames: forbiddenNamesFor(agent, roster) }),
      toBody: (o) => ({ body: { claim: clip(o.claim, CLAIM_MAX), bias: o.bias, metrics: o.metrics, name: agentName(agent) }, refs: [] })
    });
  }));
  const answered = openings.filter(m => m?.status === "ok");
  if (answered.length && answered.length * 2 < roster.length && clock() - Date.parse(barTime) < WAR_ROOM_QUORUM_WAIT_MS) {
    return { status: "waiting_for_quorum", calls, openings: answered.length, roster: roster.length };
  }
  const bus = answered.map(m => ({ id: m.agent, name: agentName(m.agent), stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, evidence: evidenceNote(m.agent), metrics: m.metrics ?? [], claim: m.claim }));
  const busAgents = bus.map(b => b.id);
  const anonBus = anonymousBus(bus, refs);

  // Phase 2: the Consensus Discussion inside this timeframe, open for at most 3 minutes.
  const majority = majorityStance(answered, "WAIT");
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
      messages: rebuttalMessages(agent, own, anonBus, unanimous, biasSplit), schemaName: "war_room_rebuttal", schema: REBUTTAL_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low", validate: (o) => validateRebuttal(o, agent, busAgents, { unanimous, ownStance: own?.stance ?? null, ownBias: own?.bias ?? null, forbiddenNames: forbiddenNamesFor(agent, roster), refs }),
      toBody: (o) => ({ body: { argument: clip(o.argument, ARGUMENT_MAX), bias: o.bias, rebuts: [...new Set(o.rebuts)].slice(0, 4), metrics: o.metrics, ...(o.conceded ? { conceded: true } : {}), name: agentName(agent) }, refs: [] })
    });
  }))).filter(m => m?.status === "ok");

  // Phase 3: the conclusion for the main panel, with the crowd line (P7, RFC §7) and its quorum.
  if (!answered.length) return { status: "no_openings", calls };
  // The 15m timeframe's own active weighting, in the regime of this bar (owner decisions 2026-11-09).
  let w15 = { reputation: await agentReputation(db, "15"), quorumShare: undefined, weighting: null, regime: null };
  try { w15 = await roomWeighting(env, db, "15", { closeMs: Date.parse(barTime), base: w15.reputation }); } catch { /* P7 reputation */ }
  const crowd = buildCrowdLine(finalEntries(answered, debate), w15.reputation, { quorumShare: w15.quorumShare, weighting: w15.weighting, regime: w15.regime });
  const conclude = phase(WAR_ROOM_CONCLUSION_MS);
  await conclude(base("conclusion", "moderator"), {
    messages: conclusionMessages(anonBus, debate.map(m => ({ ref: refs.toRef.get(m.agent) ?? null, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, rebuts: (m.rebuts || []).map((r) => refs.toRef.get(r) ?? r), metrics: m.metrics ?? [], argument: m.argument })), crowd, learnedFor("moderator")),
    schemaName: "war_room_conclusion", schema: CONCLUSION_SCHEMA, maxTokens: BUS_MAX_TOKENS.moderator, effort: "low",
    validate: (o) => validateConclusion(o, null, busAgents, null, { supportStances: new Set([...answered.map(m => m.stance), ...debate.map(m => m.stance)]), supportBiases: new Set([...answered.map(biasOf), ...debate.map(biasOf)]), roomBias, crowd, forbiddenNames: deskNames(), refs }),
    toBody: (o) => ({ body: { summary: clip(o.summary, 400), bias: o.bias, reasons: o.reasons.slice(0, 3).map(r => clip(r, 200)), dissent: [...new Set(o.dissent)], metrics: o.metrics, majority, majority_bias: roomBias, crowd }, refs: [] })
  });
  const result = { status: "complete", calls, openings: answered.length, rebuttals: debate.length };
  // Aether A7 on the 15m chart (owner 2026-11-13, "1-3"): the shadow calls of the learned notes under test,
  // handed back as a job the caller runs after the decision, so they never delay it. Not enumerable.
  if (shadowKnowledgeEnabled(env)) {
    Object.defineProperty(result, "shadow_job", {
      enumerable: false,
      value: async () => {
        const plan = planShadowCalls({ items: await shadowItems(env), roster, openings: answered, chart: "M15" });
        return runShadowCalls(env, {
          calls: plan, candleKey: m15KeyForClose(barTime), statementClose: barTime, clock, schema: OPENING_SCHEMA, schemaName: "war_room_opening", maxTokens: BUS_MAX_TOKENS.agent,
          // Like for like: the live opening's prompt (its learned notes included) plus the note under test.
          messagesFor: (agent, note) => openingMessages(agent, agentData(agent, evidence, hud, confirmations, desk15, projection), learnedFor(agent), note),
          validate: (o, agent) => validateOpening(o, agent, { verifiedLines: agent === "m15" ? (desk15.approved_by_parity ? null : 0) : calibration[agent]?.total_lines == null ? null : calibratedLines(calibration[agent]), forbiddenNames: forbiddenNamesFor(agent, roster) })
        });
      }
    });
  }
  return result;
}

/** XAUUSD trades from Sunday 22:00 to Friday 22:00 UTC. */
function marketOpenAt(ms) {
  const d = new Date(ms), day = d.getUTCDay(), h = d.getUTCHours();
  return !(day === 6 || (day === 5 && h >= 22) || (day === 0 && h < 22));
}

/** The sweep runs a missed room this long after its bar closed (the queue's room normally starts within 2 minutes). */
export const MISSED_ROOM_AFTER_MS = 4 * 60_000;

/**
 * Sweep fallback (production 2026-11-10 13:10-14:10: the 5m bars kept arriving while the 5m context was
 * not published, so the 15m rooms of 13:15 to 14:00 never met and the Decision Engine decided without
 * them): the room of the last closed 15m bar meets from the cached 5m series when it has not started
 * at all MISSED_ROOM_AFTER_MS after the close. A room that already started is left to its queue task.
 */
export async function runMissedWarRoom(env, { now = Date.now(), clock = () => Date.now() } = {}) {
  if (!warRoomEnabled(env)) return { status: "disabled" };
  if (!env?.DB) return { status: "unavailable" };
  const close = Math.floor(now / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
  if (now - close < MISSED_ROOM_AFTER_MS) return { status: "too_soon" };
  if (!marketOpenAt(close - 1)) return { status: "market_closed" };
  const barTime = new Date(close).toISOString();
  await ensureThreadSchema(env.DB);
  const started = await env.DB.prepare("SELECT 1 AS x FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? AND step = 'brief'").bind(`warroom:${barTime.slice(0, 10)}`, barTime).first();
  if (started) return { status: "already_started", bar_time: barTime };
  try {
    const result = await runWarRoomBar(env, { ...buildLiveRoomTask({ barTime }), fallback: true }, { clock });
    return { status: "ran", bar_time: barTime, result };
  } catch (e) {
    return { status: "failed", bar_time: barTime, error: String(e?.message ?? e).slice(0, 200) };
  }
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
  const pick = (m) => ({ id: m.agent, name: agentName(m.agent), status: m.status, model: m.model, fallback_used: m.fallback_used, errors: m.errors, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, ts: m.ts, claim: m.claim, argument: m.argument, rebuts: m.rebuts, rebuts_names: (m.rebuts || []).map(agentName), conceded: m.conceded === true, metrics: m.metrics ?? [] });
  // Steps run in parallel, so rows land in completion order: show them in roster order.
  const order = new Map((brief?.roster || []).map((id, i) => [id, i]));
  const byRoster = (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99);
  const openings = rows.filter(m => m.step.startsWith("open:")).map(pick).sort(byRoster);
  const debate = rows.filter(m => m.step.startsWith("debate:")).map(pick).sort(byRoster);
  const c = rows.find(m => m.step === "conclusion");
  const conclusion = c ? { status: c.status, stance: c.stance, bias: c.bias ?? null, majority_bias: c.majority_bias ?? null, confidence: c.confidence, summary: c.summary ?? null, reasons: c.reasons ?? [], dissent: (c.dissent || []).map(id => ({ id, name: agentName(id) })), majority: c.majority ?? null, h1_decision: c.h1_decision ?? null, ts: c.ts, model: c.model ?? null, fallback_used: c.fallback_used === true, ...(c.status !== "ok" ? { errors: c.errors ?? [], primary_error: c.primary_error ?? null, raw: String(c.insight ?? "").slice(0, 300) } : {}) } : null;
  const started = brief?.ts ?? rows[0].ts;
  // P7 (RFC §7): each agent's 30-day track record on the 15m chart, and the room's crowd line.
  const rep = await agentReputation(db, "15");
  const ids = [...new Set([...(brief?.roster || openings.map(o => o.id)), "moderator"])];
  return {
    bar_time: run,
    reputation: roomReputation(ids, rep),
    crowd: c?.crowd ?? (openings.some(o => o.status === "ok") ? buildCrowdLine(finalEntries(openings, debate), rep) : null),
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
