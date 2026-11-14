// Timeframe War Rooms (owner decisions 2026-11-05 and 2026-11-06): Nexus shows one Thread per
// timeframe as a tab in the right panel, D1, 4H, 1H and 15m, and every Thread is the consensus
// of all agents, as in the Live War Room:
//
//   15m is the Live War Room itself (src/war-room.mjs);
//   1H, 4H and D1 run here, once per closed bar of that chart, in the same three phases:
//     1. Communication bus: every agent opens with one claim from its own data only;
//     2. Consensus Discussion (owner decision 2026-11-07: the term replaces "debate"): minority
//        agents (by bias and confidence) and the Risk Manager answer named agents, open for at
//        most 3 minutes;
//     3. Conclusion: the moderator writes the TLDR of that timeframe.
//
// The agents: the desks (the room's own timeframe desk: the 1H, 4H or D1 Desk with the local
// records of the bar; the Higher-Timeframe Desk, News Analyst, Technical Analyst, Risk Manager)
// and one agent per HUD computed on that chart (the HUD snapshot of the bar). The rooms run from
// local computation only, never from a webhook: the bars, the HUD snapshot and the local Prophet
// R38, R37 and GMI records of the bar.
//
// Rules: one role per agent and no repetition; HUD statements are marked verified only where
// they equal a parity-approved record (a label, not a cap: owner decision 2026-11-09). A BUY or
// SELL conclusion needs the room's quorum (reputation.mjs quorumAllows): more than half of the
// agents' track-record weight holding the matching bias. Indicator confirmations are arguments. Advisory only: stances are discussion positions, never
// orders, and no price level comes from here.
//
// The 1H room comes BEFORE the H1 decision (owner decision 2026-11-07): its bus, Consensus
// Discussion and conclusion are the Reasoner's input, and the Reasoner decides last
// (src/h1-consensus.mjs). The room therefore never reads an H1 decision of its own bar.
//
// Runs from the parity sweep cron, behind TF_THREADS_ENABLED, within its own hourly budget
// (TF_THREADS_MAX_CALLS_PER_HOUR).
import { chatMessages } from "./model-text.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";
import { HUD_NAMES, calibrationCounts, calibrationNote, hudAgentsIn } from "./hud-reading.mjs";
import { loadHudSnapshot, hudReadings } from "./hud-store.mjs";
import { BUS_DEFAULT_MODEL, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { ensureThreadSchema, rowToThreadMessage, ROOM_STANCES, hudEvidenceLines, threadInternals } from "./agent-threads.mjs";
import {
  validateOpening, validateRebuttal, majorityStance, selectRebutters, BIAS_RULE, SUPPORT_RULE, stanceSupported,
  majorityBias, biasOfStance, biasSplitText, DECISION_BIAS_RULE, conclusionBiasErrors, agentIdsToNames,
  INDEPENDENCE_RULE, namesErrors, metricsErrors, forbiddenNamesFor, busRefs, anonymousBus, deskNames, inferredMetrics, normalizeAnswerText,
  WAR_ROOM_OPENING_MS, WAR_ROOM_DEBATE_MS, WAR_ROOM_CONCLUSION_MS
} from "./war-room.mjs";
import { closedHtfCandleKeys, OBSERVED_PREFIX } from "./parity-sweep.mjs";
import { newsDeskEvidence } from "./news-daily.mjs";
import { chartDeskReading, chartDeskLabel } from "./timeframe-desk.mjs";
import { projectionReading } from "./projection-agent.mjs";
import { readPatternCalibration } from "./pattern-calibration.mjs";
import { H1_ROOM_LOCK_PREFIX } from "./h1-consensus.mjs";
import { buildCrowdLine, finalEntries, crowdRule, roomReputation, stuckCautions, ROOM_TIMEFRAME, quorumAllows, quorumRule } from "./reputation.mjs";
import { agentReputation, listStuckStates } from "./outcome-scoring.mjs";
import { readAllocationState, rosterSplit } from "./agent-allocation.mjs";
import { roomWeighting } from "./weighting.mjs";
import { shadowKnowledgeEnabled, shadowItems, planShadowCalls, runShadowCalls } from "./shadow-knowledge.mjs";
import { learnedBlock, learnedPackInfo, learnedKnowledgeEnabled } from "./learned-knowledge.mjs";
import { effectiveLearnedPack } from "./learned-live.mjs";
import { sessionOf } from "./outcome-scoring.mjs";
import { eventRisk, gatedEvents } from "./econ-calendar.mjs";
import { projectEvent } from "./calendar-agent.mjs";

// With the Calendar Agent's projection (owner decision 2026-11-08): which way gold usually moves.
const eventLine = (e, now) => { const p = projectEvent(e, now); return `${e.title} (${e.currency}, ${e.time.slice(11, 16)} UTC)${p ? `: ${p.text}` : ""}`; };

const { runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, ROOM_RULES_INDEPENDENT, clip, inUnit, parseJson } = threadInternals;

const SYMBOL = "OANDA:XAUUSD";
export const TF_THREAD_CHARTS = Object.freeze({
  H1: { period: "60", series: "1h", label: "1-hour", tab: "1H", higher: "H4", minutes: 60 },
  H4: { period: "240", series: "4h", label: "4-hour", tab: "4H", higher: "D1", minutes: 240 },
  D1: { period: "1D", series: "1D", label: "daily", tab: "D1", higher: null, minutes: 1440 }
});
export const TF_DESKS = Object.freeze({
  // Each room's own timeframe desk (owner decision 2026-11-06: a desk analyses only its chart).
  h1: { name: "1H Desk", role: "the local Prophet (signal, direction, structure, trade management) and GMI computation of the 1-hour candle that just closed: this timeframe's own signal" },
  h4: { name: "4H Desk", role: "the local Prophet (signal, direction, structure, trade management) and GMI computation of the 4-hour candle that just closed: this timeframe's own signal" },
  d1: { name: "D1 Desk", role: "the local Prophet (signal, direction, structure, trade management) and GMI computation of the daily candle that just closed: this timeframe's own signal" },
  news: { name: "News Analyst", role: "the fundamental news of the last 24 hours: the daily bias for gold and the headlines behind it" },
  technical: { name: "Technical Analyst", role: "price action only: the last closed candles of this chart" },
  risk: { name: "Risk Manager", role: "risk only: the volatility of this chart, this chart's own indicator readings and economic calendar, and what would invalidate a move" },
  projection: { name: "Projection Agent", role: "where a move projects on this chart: Fibonacci, the probability cone, trendlines and the chart patterns, each pattern with its record on gold" }
});
export const TF_ROOM_MAX_REBUTTALS = 8;
const CLAIM_MAX = 320;
const ARGUMENT_MAX = 420;
/** A bar's room waits for its HUD snapshot this long after the close, then runs without it. */
export const TF_HUD_WAIT_MS = 20 * 60 * 1000;
/** The run id suffix of a room that re-convened once its late HUD snapshot arrived. */
export const RECONVENE_SUFFIX = "#hud";
const barOpenOf = (runId) => String(runId).split("#")[0];
/**
 * Gap between two rooms of one sweep: the Workers AI per-minute limit is shared, and one room
 * spends about 22 calls within a minute (production 2026-11-06: a 1H room started right after the
 * 4H room lost 14 of its openings to "inference request per min rate reached").
 */
export const TF_ROOM_GAP_MS = 65_000;
/**
 * A room concludes only when at least half of its agents spoke; otherwise its failed openings are
 * retried by the next sweep. After TF_QUORUM_WAIT_MS past the close it concludes with whoever spoke.
 */
export const TF_QUORUM_WAIT_MS = 2 * 60 * 60 * 1000;

export function tfThreadsEnabled(env) {
  return String(env?.TF_THREADS_ENABLED || "").toLowerCase() === "true";
}

export function tfAgentName(id) {
  if (TF_DESKS[id]) return TF_DESKS[id].name;
  // Retired 2026-11-09 (independent rooms): kept only to name the agent in stored rooms.
  if (id === "htf") return "Higher-Timeframe Desk";
  if (HUD_NAMES[id]) return HUD_NAMES[id];
  return id === "moderator" ? "Moderator" : String(id);
}

/**
 * The quorum decides (owner decision 2026-11-09, replacing "no confirmation, no entry"): a BUY or SELL
 * conclusion needs the weighted majority of the agents who spoke holding the matching bias
 * (quorumAllows, src/reputation.mjs). The chart's Prophet R38 confirmation and setup state stay in the
 * evidence as arguments the agents weigh.
 */
const ruleText = (spec) =>
  `Rule: the room's quorum decides. A BUY or SELL conclusion of the ${spec.label} room needs more than half of the agents' weight (each weighted by its track record) holding the matching bias; otherwise the stance is WAIT, or HOLD / CLOSE for a position already open. The ${spec.label} Prophet R38 confirmation and setup state, the trade management and the GMI verdict are arguments to weigh, not gates.`;

// The rooms require a "metrics" list (owner decisions 2026-11-09, war-room.mjs metricsErrors). Strict JSON
// schemas without it (until 2026-11-11) made the model drop the list every time: each answer then cost a
// correction call and was kept with inferred metrics (production 2026-11-10: 438 corrections in 874 tf answers).
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

const ROOM_RULES = [
  "Room stances: BUY, SELL, HOLD (keep an existing position), WAIT (stay flat), CLOSE (exit an existing position). They are discussion positions about this timeframe only.",
  "Never give entry, stop loss, take profit or position size: price levels come only from the validated H1 decision chain."
].join("\n");

/** Agent ids and rebuttal targets given as display names are mapped to their ids. */
function normalizeTfNames(o, busAgents) {
  if (!o || typeof o !== "object") return o;
  const byName = new Map(busAgents.map((id) => [tfAgentName(id).toLowerCase(), id]));
  const toId = (r) => (busAgents.includes(r) ? r : byName.get(String(r ?? "").trim().toLowerCase()) ?? r);
  if (Array.isArray(o.rebuts)) o.rebuts = o.rebuts.map(toId);
  if (Array.isArray(o.dissent)) o.dissent = o.dissent.map(toId);
  if (typeof o.agent === "string") o.agent = toId(o.agent);
  return o;
}

/**
 * The moderator's TLDR of one timeframe: stance, summary, one to three reasons and the dissent.
 * BUY or SELL needs the room's quorum (when the crowd line is given); a stance that differs from the H1 decision
 * must name it.
 */
export function validateTfConclusion(o, { busAgents = [], crowd = undefined, h1Decision = null, supportStances = null, supportBiases = null, roomBias = "NEUTRAL", forbiddenNames = null, refs = null } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  if (forbiddenNames) normalizeAnswerText(o);
  agentIdsToNames(o, busAgents, tfAgentName);
  if (refs && Array.isArray(o.dissent)) o.dissent = o.dissent.map(refs.idOf);
  const errors = [];
  if (!ROOM_STANCES.includes(o.stance)) errors.push("stance_invalid");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.summary !== "string" || !o.summary.trim()) errors.push("summary_missing");
  else {
    errors.push(...naturalLanguageErrors(o.summary));
    const h1 = h1Decision ? String(h1Decision).toUpperCase() : null;
    if (h1 && ROOM_STANCES.includes(o.stance) && o.stance !== h1 && !new RegExp(`H1[^.]{0,40}${h1}`, "i").test(o.summary)) errors.push("h1_reference_missing");
  }
  if (crowd !== undefined && !quorumAllows(o.stance, crowd)) errors.push("entry_without_quorum");
  // Independence (owner decisions 2026-11-09): the moderator names metrics, never an agent or a role.
  if (forbiddenNames) {
    errors.push(...namesErrors(o.summary, forbiddenNames), ...(Array.isArray(o.reasons) ? o.reasons.flatMap((r) => namesErrors(r, forbiddenNames)) : []));
    errors.push(...metricsErrors(o));
  }
  if (!stanceSupported(o.stance, supportStances)) errors.push("stance_without_support");
  errors.push(...conclusionBiasErrors(o, { supportBiases, roomBias }));
  if (Array.isArray(o.reasons)) o.reasons = o.reasons.filter((r) => !(typeof r === "string" && !r.trim()));
  if (!Array.isArray(o.reasons) || o.reasons.length < 1 || o.reasons.some((r) => typeof r !== "string")) errors.push("reasons_invalid");
  else for (const r of o.reasons.slice(0, 3)) errors.push(...naturalLanguageErrors(r));
  if (o.dissent == null) o.dissent = [];
  normalizeTfNames(o, busAgents);
  if (!Array.isArray(o.dissent) || o.dissent.some((d) => !busAgents.includes(d))) errors.push("dissent_invalid");
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

const round = (x, d = 2) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

async function seriesBars(env, key) {
  try {
    const record = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:" + key)) || "null");
    return Array.isArray(record?.candles) ? record.candles : [];
  } catch { return []; }
}

async function localProphet(env, candleKey) {
  for (const prefix of ["localcalc:", OBSERVED_PREFIX]) {
    try {
      const raw = await env.WEBHOOK_BUFFER?.get?.(prefix + candleKey + ":prophet");
      if (raw) return { record: JSON.parse(raw), approved: prefix === "localcalc:" };
    } catch { /* unreadable: try the next */ }
  }
  return null;
}

/**
 * Evidence for one closed 1H, 4H or D1 bar; null when the bar is not in the cached series yet.
 * Fields that are not available stay null, never invented.
 */
export async function tfEvidence(env, chart, candleKey) {
  const spec = TF_THREAD_CHARTS[chart];
  const db = env.DB;
  const openMs = Number(candleKey.split(":").at(-1));
  const bars = (await seriesBars(env, `${SYMBOL}|${spec.series}`)).filter((b) => Date.parse(b.open_time) <= openMs);
  const last = bars.at(-1);
  if (!last || Date.parse(last.open_time) !== openMs) return null;
  const candles = bars.slice(-12).map((b) => ({ open: b.open_time, o: round(b.open), h: round(b.high), l: round(b.low), c: round(b.close) }));
  const ranges = bars.slice(-14).map((b) => b.high - b.low);

  let snapshot = null, hud = null;
  try {
    snapshot = await loadHudSnapshot(env, { timeframe: spec.period, candleKey });
    hud = snapshot ? await hudReadings(env, snapshot) : null;
  } catch { hud = null; }

  const prophet = await localProphet(env, candleKey);
  const r38 = prophet?.record?.values?.comparable?.prophet_r38 || null;
  const setup = prophet?.record?.values?.setup || null;
  const funnel = snapshot?.huds?.r37_funnel?.fields || null;
  const confirmations = {
    chart_prophet_r38: {
      buy_confirmed: (r38?.buy_confirmed ?? funnel?.buy_confirmed) === true,
      sell_confirmed: (r38?.sell_confirmed ?? funnel?.sell_confirmed) === true,
      // The setup state (owner report 2026-11-09): READY while the confirmation that passed is
      // still inside its window and the cycle alignment holds; the local record carries it.
      buy_setup_ready: setup?.buy_ready === true,
      sell_setup_ready: setup?.sell_ready === true,
      ...(setup ? { setup_pass_age: setup.buy_ready ? setup.buy_pass_age : setup.sell_ready ? setup.sell_pass_age : null, setup_window: setup.confirmation_window ?? null, setup_instruction: setup.instruction ?? null } : {}),
      approved_by_parity: prophet?.approved === true,
      source: r38 ? "the local Prophet R38 record of this bar" : funnel ? "the R37 funnel HUD of this bar" : "not available"
    }
  };

  // Owner decisions 2026-11-09: independent rooms. No higher-timeframe conclusion and no other room
  // (the Macro War Room included): each agent reads only its own data on this timeframe.
  const higher = null;
  const news = await newsDeskEvidence(db);
  let desk = { available: false, reading: [], approved_by_parity: false };
  try { desk = await chartDeskReading(env, candleKey); } catch { /* no desk reading this bar */ }
  // Event-risk gate (backlog 11.1): the high-impact USD events around this bar, for the Risk Desk.
  let eventRiskNow = null;
  try {
    const closeMs = Date.parse(last.close_time);
    const r = eventRisk(await gatedEvents(env, { now: closeMs }), closeMs);
    if (r.active.length || r.next.length) eventRiskNow = { rule: "a high-impact USD event from 2 hours before to 30 minutes after it is a caution, never a forced wait", due_now: r.active.map((e) => eventLine(e, closeMs)), next_24h: r.next.map((e) => eventLine(e, closeMs)) };
  } catch { eventRiskNow = null; }
  return {
    chart, candle_key: candleKey, bar_open: last.open_time, bar_close: last.close_time,
    technical: { candles, average_range_14: round(ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1)) },
    hud, confirmations, higher, news, desk, event_risk: eventRiskNow,
    // The Projection Agent (owner 2026-11-12): this chart's patterns and projection levels, no price.
    projection: await (async () => {
      try { return projectionReading({ bars, plane: snapshot?.chart_plane ?? null, calibration: await readPatternCalibration(env), timeframe: spec.label }); } catch { return null; }
    })()
  };
}

function agentData(agent, ev, spec) {
  switch (agent) {
    case "h1": case "h4": case "d1": return { timeframe: spec.label, reading: ev.desk.reading, approved_by_parity: ev.desk.approved_by_parity };
    case "news": return ev.news;
    case "projection": return ev.projection ?? { available: false };
    case "technical": return { timeframe: spec.label, closed_candles: ev.technical.candles };
    case "risk": return {
      timeframe: spec.label, ranges: ev.technical.candles.map((c) => round(c.h - c.l)), average_range_14: ev.technical.average_range_14,
      confirmations: ev.confirmations,
      ...(ev.event_risk ? { economic_calendar: ev.event_risk } : {})
    };
    default: return { hud: HUD_NAMES[agent], timeframe: spec.label, reading: hudEvidenceLines(ev.hud?.readings?.[agent]) };
  }
}


function openingMessages(agent, data, spec, roster, note = null, learned = null) {
  const desk = TF_DESKS[agent];
  const riskRule = agent === "risk" ? [ruleText(spec) + " Judge the risk of every possible entry from your data: this chart's volatility, its indicator readings, the economic calendar and what would invalidate the move, and say plainly whether you would take it."] : [];
  const who = desk
    ? `You are the ${desk.name} in the XAUUSD ${spec.label} War Room, which meets at every closed ${spec.label} candle. Your only role: ${desk.role}.`
    : `You are ${HUD_NAMES[agent]}, one agent per Pine HUD, in the XAUUSD ${spec.label} War Room. You speak only about the ${HUD_NAMES[agent]} HUD on the ${spec.label} candle that just closed. Lean on the statements marked verified by parity or computed from verified bars. The readers already see your calibration status once, next to your name: never mention calibration, verification or comparators in your claim. Give the confidence your reading supports: your weight in the room comes from your track record.`;
  return chatMessages([
    who,
    ROOM_RULES_INDEPENDENT,
    ROOM_RULES,
    ...riskRule,
    INDEPENDENCE_RULE,
    "This is your opening on the communication bus: one claim from your own data only.",
    BIAS_RULE,
    // Aether A7 shadow arm only (src/shadow-knowledge.mjs): a reviewed learned note, never in a live opening.
    ...(note ? [note] : []),
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"claim":"<= ${CLAIM_MAX - 40} chars","metrics":["<the metrics you decided from, plain words>"]}`,
    "YOUR DATA:",
    JSON.stringify(data ?? { available: false }),
    // Aether A9 (src/learned-knowledge.mjs): the bundled learned notes for this agent, only with LEARNED_KNOWLEDGE_ENABLED.
    ...(learned ? [learned] : [])
  ]);
}

function rebuttalMessages(agent, own, bus, spec, unanimous, confirmations, roomBias = null) {
  const riskRule = agent === "risk" ? [ruleText(spec) + " Challenge every statement on the bus whose BUY or SELL ignores a risk you see in this chart's metrics. INDICATOR READINGS (arguments, not gates): " + JSON.stringify(confirmations)] : [];
  return chatMessages([
    `You are ${tfAgentName(agent)} in the XAUUSD ${spec.label} War Room Consensus Discussion${TF_DESKS[agent] ? " (" + TF_DESKS[agent].role + ")" : ""}. The bus below holds every opening of this bar on this timeframe, anonymously. The Consensus Discussion is open for at most 3 minutes.`,
    ROOM_RULES_INDEPENDENT,
    ROOM_RULES,
    INDEPENDENCE_RULE,
    unanimous && roomBias && agent !== "risk"
      ? biasSplitText(roomBias)
      : unanimous
        ? "The bus is unanimous. Stress-test the consensus: challenge the statement most likely to be wrong, put its reference in rebuts, and say which metric would invalidate the consensus. Add only new reasoning from your own metrics; never restate a claim."
        : "Rebut the statements you disagree with and put their references (#n) in rebuts. Argue from your own metrics against theirs; never restate your opening or another claim. You may change your stance or your bias if the bus convinced you: then put the references of the statements that convinced you in rebuts (or leave it empty).",
    ...riskRule,
    "Refer to bus statements only by their # reference, and only in the rebuts field: the argument names metrics, never an agent or a role. Each bus entry says how much of its data is verified by parity or computed from verified bars: weigh that evidence above uncalibrated readings, and never discuss calibration itself.",
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"rebuts":["#n"],"argument":"<= ${ARGUMENT_MAX - 40} chars","metrics":["<the metrics you argue from>"]}`,
    "YOUR OPENING: " + JSON.stringify({ stance: own.stance, bias: own.bias ?? null, confidence: own.confidence, metrics: own.metrics ?? [], claim: own.claim }),
    "COMMUNICATION BUS (ref, stance, bias, confidence, evidence, metrics, claim):",
    JSON.stringify(bus)
  ]);
}

function conclusionMessages(spec, bus, debate, confirmations, crowd = null, learned = null) {
  return chatMessages([
    `You are the moderator of the XAUUSD ${spec.label} War Room. The Consensus Discussion is closed. Write the TLDR of the ${spec.label} Thread: the consensus of the room on this timeframe.${spec.tab === "1H" ? " The Reasoner writes the H1 decision after you, from this room's consensus." : ""}`,
    ROOM_RULES_INDEPENDENT,
    ROOM_RULES,
    ...(crowd ? [crowdRule(crowd)] : []),
    ruleText(spec) + " The conclusion obeys it. " + (crowd ? quorumRule(crowd) : "There is no crowd line, so there is no quorum: the conclusion is WAIT, HOLD or CLOSE.") + " INDICATOR READINGS (arguments, not gates): " + JSON.stringify(confirmations),
    SUPPORT_RULE,
    DECISION_BIAS_RULE + " A BULLISH or BEARISH bias needs at least one agent holding it.",
    "Weigh statements by their metrics and their evidence, not by their number: a statement built on data verified by parity, or computed from verified bars, outweighs one built on uncalibrated readings (each entry states which). No repetition: the summary states the conclusion once, each reason adds something new. In the summary and reasons name the metrics that decided, never an agent or a role, and never another timeframe's room; dissent lists the # references of statements whose stance or bias still differs from yours. Never discuss calibration itself.",
    'Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"summary":"<= 360 chars","reasons":["<= 160 chars", "at most 3"],"dissent":["#n"],"metrics":["<the metrics that decided>"]}',
    "COMMUNICATION BUS:",
    JSON.stringify(bus),
    "CONSENSUS DISCUSSION:",
    JSON.stringify(debate),
    ...(learned ? [learned] : [])
  ]);
}

/** The strict JSON schemas of the 1H, 4H and D1 rooms (exported for the schema test). */
export const TF_ROOM_SCHEMAS = Object.freeze({ opening: OPENING_SCHEMA, rebuttal: REBUTTAL_SCHEMA, conclusion: CONCLUSION_SCHEMA });

/** Runs the War Room of one closed 1H, 4H or D1 bar; idempotent per bar. */
/**
 * The weighting of a room's crowd line (src/weighting.mjs, owner decisions 2026-11-09): every room uses
 * its own timeframe's active weighting (tuned automatically), in the regime of its own bar.
 */
async function roomWeightingFor(env, db, chart, closeMs = Date.now()) {
  const base = await agentReputation(db, ROOM_TIMEFRAME[chart]);
  try { return await roomWeighting(env, db, ROOM_TIMEFRAME[chart], { closeMs, base }); }
  catch { return { reputation: base, quorumShare: undefined, weighting: null, regime: null }; }
}
async function roomReputationMap(env, db, chart, closeMs) {
  return (await roomWeightingFor(env, db, chart, closeMs)).reputation;
}
async function crowdOptions(env, chart, closeMs) {
  const w = await roomWeightingFor(env, env.DB, chart, closeMs);
  return { quorumShare: w.quorumShare, weighting: w.weighting, regime: w.regime };
}
async function roomCrowd(env, db, chart, entries, closeMs) {
  const w = await roomWeightingFor(env, db, chart, closeMs);
  return buildCrowdLine(entries, w.reputation, { quorumShare: w.quorumShare, weighting: w.weighting, regime: w.regime });
}

export async function runTimeframeThread(env, { chart, candleKey }, { clock = () => Date.now() } = {}) {
  const spec = TF_THREAD_CHARTS[chart];
  if (!spec) return { status: "unsupported_chart" };
  const db = env.DB;
  await ensureThreadSchema(db);
  const ev = await tfEvidence(env, chart, candleKey);
  if (!ev) return { status: "no_bar" };
  const threadId = `tf:${chart}`;
  await upsertThread(db, { id: threadId, kind: "tf", refKey: chart, title: `Thread ${spec.tab} · XAUUSD ${spec.label} War Room`, post: null, now: clock() });
  const load = async (id) => new Map(((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ?").bind(threadId, id).all()).results || []).map((r) => [r.step, rowToThreadMessage(r)]));
  let runId = ev.bar_open;
  let existing = await load(runId);
  let reconvened = false;
  if (existing.get("conclusion")?.status === "ok") {
    // D1 catch-up (owner decision 2026-11-06): a room that concluded without its HUD snapshot
    // meets once more, under the same bar, when the snapshot arrives late. The second session
    // sorts after the first (run_id + RECONVENE_SUFFIX), so the tab and the rooms below read it.
    if (existing.get("brief")?.hud_snapshot !== false || !ev.hud) return { status: "already_complete", calls: 0 };
    runId = ev.bar_open + RECONVENE_SUFFIX;
    existing = await load(runId);
    if (existing.get("conclusion")?.status === "ok") return { status: "already_complete", calls: 0 };
    reconvened = true;
  }

  // The room's own timeframe desk first: the 1H, 4H or D1 Desk with the local records of the bar.
  const ownDesk = ev.desk?.available ? { H1: "h1", H4: "h4", D1: "d1" }[chart] : null;
  const fullRoster = [
    ...(ownDesk ? [ownDesk] : []), ...(ev.news ? ["news"] : []), "technical", "risk", ...(ev.projection?.available ? ["projection"] : []),
    ...hudAgentsIn(chart).filter((id) => ev.hud?.readings?.[id]?.available)
  ];
  // Neuron allocation by reputation (src/agent-allocation.mjs): an agent in shadow in this room answers beside
  // the bus on every fourth bar, never in it.
  const allocation = rosterSplit(fullRoster, (await readAllocationState(env)).rooms?.[chart], { room: chart, barTime: ev.bar_close });
  const roster = allocation.live;
  const calibration = Object.fromEntries(fullRoster.map((id) => {
    const lines = ev.hud?.readings?.[id]?.lines;
    if (Array.isArray(lines)) return [id, calibrationCounts(lines)];
    if (id === "h1" || id === "h4" || id === "d1") return [id, { label: chartDeskLabel(spec.tab, ev.desk) }];
    if (id === "news") return [id, { label: "news of the last 24 hours" }];
    return [id, { label: `closed ${spec.label} bars` }];
  }));
  const evidenceNote = (id) => {
    const c = calibration[id] || {};
    if (c.total_lines == null) return c.label || null;
    return calibrationNote(c, "no statement calibrated yet");
  };
  const base = (step, agent, parent_id = null) => ({ thread_id: threadId, run_id: runId, step, agent, parent_id, bar_time: ev.bar_close });
  // Aether A9: the bundled learned notes (deterministic per agent, chart and session); none unless enabled.
  const learnedCtx = { chart: { H1: "60", H4: "240", D1: "1D" }[chart], session: sessionOf(Date.parse(ev.bar_close)) };
  // The bundled pack plus the notes promoted autonomously (src/learned-live.mjs); read only when the notes are on.
  const learnedPack = learnedKnowledgeEnabled(env) ? await effectiveLearnedPack(env) : undefined;
  const learnedFor = (agent) => learnedBlock(env, { agent, ...learnedCtx, pack: learnedPack });
  if (!existing.has("brief")) {
    await writeMessage(db, { ...base("brief", "system"), ts: new Date(clock()).toISOString(), status: "info", body: {
      chart, candle_key: candleKey, roster, ...(allocation.benched.length ? { benched: allocation.benched, shadow: allocation.shadow } : {}), calibration, confirmations: ev.confirmations, bar: ev.technical.candles.at(-1) ?? null,
      hud_snapshot: Boolean(ev.hud),
      // Which learned pack and notes the room saw (RFC §10); recorded only when the notes are on.
      ...(learnedKnowledgeEnabled(env) ? { learned_pack: learnedPackInfo(env, { roster, ...learnedCtx, pack: learnedPack }) } : {}),
      independent: true, news: ev.news ? { consensus: ev.news.consensus } : null
    } });
  }

  const roomEnv = env;
  const maxPerHour = Number(env.TF_THREADS_MAX_CALLS_PER_HOUR ?? 140);
  let remaining = 0;
  try { remaining = (Number.isFinite(maxPerHour) ? maxPerHour : 0) - (await callsInLastHour(db, clock(), "tf")); } catch { remaining = 0; }
  let calls = 0;
  const phase = (ms) => {
    const deadline = clock() + ms;
    const runState = { primaryError: null };
    const budgetOk = async () => clock() < deadline && remaining-- > 0;
    return (stepBase, opts) => { calls += 1; return runStep(roomEnv, db, stepBase, { inferMetrics: (b) => inferredMetrics(b?.agent), ...opts, deadline, clock, runState, budgetOk }); };
  };

  // Phase 1: the communication bus.
  const open = phase(WAR_ROOM_OPENING_MS);
  const openingOpts = (agent) => ({
    messages: openingMessages(agent, agentData(agent, ev, spec), spec, roster, null, learnedFor(agent)), schemaName: "tf_room_opening", schema: OPENING_SCHEMA,
    maxTokens: BUS_MAX_TOKENS.agent, effort: "low",
    // No parity cap on the confidence (owner decision 2026-11-09: "confidences sesuai kapasitasnya");
    // each agent's weight in the quorum comes from its track record (P7), which Aether tunes.
    validate: (o) => validateOpening(normalizeTfNames(o, [agent]), agent, { forbiddenNames: forbiddenNamesFor(agent, fullRoster, tfAgentName) }),
    toBody: (o) => ({ body: { claim: clip(o.claim, CLAIM_MAX), bias: o.bias, metrics: o.metrics, name: tfAgentName(agent) }, refs: [] })
  });
  const shadowOpenings = Promise.all(allocation.shadow.map((agent) => existing.get("shadow:" + agent)?.status === "ok" ? null : open(base("shadow:" + agent, agent), openingOpts(agent)).catch(() => null)));
  const openings = await Promise.all(roster.map((agent) => {
    const prior = existing.get("open:" + agent);
    if (prior?.status === "ok") return prior;
    return open(base("open:" + agent, agent), openingOpts(agent));
  }));
  await shadowOpenings;
  const answered = openings.filter((m) => m?.status === "ok");
  if (!answered.length) return { status: "no_openings", calls };
  const young = clock() - Date.parse(ev.bar_close) < TF_QUORUM_WAIT_MS;
  if (young && answered.length * 2 < roster.length) return { status: "waiting_for_quorum", calls, openings: answered.length, roster: roster.length };
  const bus = answered.map((m) => ({ id: m.agent, name: tfAgentName(m.agent), stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, evidence: evidenceNote(m.agent), metrics: m.metrics ?? [], claim: m.claim }));
  const busAgents = bus.map((b) => b.id);
  // The anonymous bus (owner decisions 2026-11-09): "#n" references, never an agent's name.
  const refs = busRefs(roster);
  const anonBus = anonymousBus(bus, refs);

  // Phase 2: the Consensus Discussion inside this timeframe, open for at most 3 minutes.
  const majority = majorityStance(answered, "WAIT");
  const roomBias = majorityBias(answered);
  const rebutters = selectRebutters(answered, majority, TF_ROOM_MAX_REBUTTALS, { bias: roomBias });
  const unanimous = answered.every((m) => m.stance === majority);
  const biasSplit = unanimous && rebutters.some((a) => a !== "risk") ? roomBias : null;
  const debateStep = phase(WAR_ROOM_DEBATE_MS);
  const openingId = new Map(answered.map((m) => [m.agent, m.id]));
  const debate = (await Promise.all(rebutters.map((agent) => {
    const prior = existing.get("debate:" + agent);
    if (prior?.status === "ok") return prior;
    const own = answered.find((m) => m.agent === agent);
    return debateStep(base("debate:" + agent, agent, openingId.get(agent) ?? null), {
      messages: rebuttalMessages(agent, own, anonBus, spec, unanimous, ev.confirmations, biasSplit), schemaName: "tf_room_rebuttal", schema: REBUTTAL_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low",
      validate: (o) => { if (Array.isArray(o?.rebuts)) o.rebuts = o.rebuts.map(refs.idOf); return validateRebuttal(normalizeTfNames(o, busAgents), agent, busAgents, { unanimous, ownStance: own?.stance ?? null, ownBias: own?.bias ?? null, forbiddenNames: forbiddenNamesFor(agent, roster, tfAgentName) }); },
      toBody: (o) => ({ body: { argument: clip(o.argument, ARGUMENT_MAX), bias: o.bias, rebuts: [...new Set(o.rebuts)].slice(0, 4), metrics: o.metrics, ...(o.conceded ? { conceded: true } : {}), name: tfAgentName(agent) }, refs: [] })
    });
  }))).filter((m) => m?.status === "ok");

  // Phase 3: the TLDR of this timeframe, with the crowd line (P7, RFC §7).
  const crowd = await roomCrowd(env, db, chart, finalEntries(answered, debate), Date.parse(ev.bar_close));
  const conclude = phase(WAR_ROOM_CONCLUSION_MS);
  await conclude(base("conclusion", "moderator"), {
    messages: conclusionMessages(spec, anonBus, debate.map((m) => ({ ref: refs.toRef.get(m.agent) ?? null, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, rebuts: (m.rebuts || []).map((r) => refs.toRef.get(r) ?? r), metrics: m.metrics ?? [], argument: m.argument })), ev.confirmations, crowd, learnedFor("moderator")),
    schemaName: "tf_room_conclusion", schema: CONCLUSION_SCHEMA, maxTokens: BUS_MAX_TOKENS.moderator, effort: "low",
    validate: (o) => validateTfConclusion(o, { busAgents, crowd, forbiddenNames: deskNames(tfAgentName, Object.keys(TF_DESKS)), refs, supportStances: new Set([...answered.map((m) => m.stance), ...debate.map((m) => m.stance)]), supportBiases: new Set([...answered, ...debate].map((m) => m.bias || biasOfStance(m.stance))), roomBias }),
    toBody: (o) => ({ body: { summary: clip(o.summary, 400), bias: o.bias, reasons: o.reasons.slice(0, 3).map((r) => clip(r, 200)), dissent: [...new Set(o.dissent)], metrics: o.metrics, majority, majority_bias: roomBias, crowd }, refs: [] })
  });
  const result = { status: "complete", calls, openings: answered.length, rebuttals: debate.length, ...(reconvened ? { reconvened: true } : {}) };
  // Aether A7 (src/shadow-knowledge.mjs): the shadow calls of the approved notes, handed back as a job
  // the caller runs after the H1 decision, so they never delay it. Not enumerable: logs never show it.
  if (chart === "H1" && shadowKnowledgeEnabled(env)) {
    Object.defineProperty(result, "shadow_job", {
      enumerable: false,
      value: async () => {
        const plan = planShadowCalls({ items: await shadowItems(env), roster, openings: answered, chart });
        return runShadowCalls(env, {
          calls: plan, candleKey, statementClose: ev.bar_close, clock, schema: OPENING_SCHEMA, maxTokens: BUS_MAX_TOKENS.agent,
          // Like for like: the live opening's prompt (its bundled notes included) plus the note under test.
          messagesFor: (agent, note) => openingMessages(agent, agentData(agent, ev, spec), spec, roster, note, learnedFor(agent)),
          validate: (o, agent) => validateOpening(normalizeTfNames(o, [agent]), agent)
        });
      }
    });
  }
  return result;
}

/** Runs a room's deferred shadow job (Aether A7), if any. Never throws. */
export async function runShadowJob(result) {
  if (typeof result?.shadow_job !== "function") return null;
  try { return await result.shadow_job(); } catch (error) { return { status: "error", message: error instanceof Error ? error.message.slice(0, 200) : String(error) }; }
}

/** The latest closed H1 bar key (H1 bars are epoch-aligned). */
export function closedH1Key(now) {
  const h = 3600_000;
  return `${SYMBOL}:60:${Math.floor(now / h) * h - h}`;
}

/**
 * The bars whose room is due: the latest closed 1H, 4H and D1 bar. A bar waits for its HUD
 * snapshot for TF_HUD_WAIT_MS after its close, then runs with the desks only.
 */
async function dueBars(env, now) {
  const keys = [closedH1Key(now), ...(await closedHtfCandleKeys(env, now, { lookback: 1 }))];
  const due = [];
  for (const key of keys) {
    const period = key.split(":")[2];
    const chart = Object.keys(TF_THREAD_CHARTS).find((c) => TF_THREAD_CHARTS[c].period === period);
    if (!chart) continue;
    const closeMs = Number(key.split(":").at(-1)) + TF_THREAD_CHARTS[chart].minutes * 60_000;
    // The h1_room queue task runs this bar's 1H room right after the close (src/h1-consensus.mjs).
    if (chart === "H1") {
      let held = null;
      try { held = await env.SIGNAL_CACHE?.get?.(H1_ROOM_LOCK_PREFIX + key); } catch { held = null; }
      if (held) continue;
    }
    let snapshot = null;
    try { snapshot = await env.SIGNAL_CACHE?.get?.(`hud:${period}:${key}`); } catch { snapshot = null; }
    if (!snapshot && now - closeMs < TF_HUD_WAIT_MS) continue;
    due.push({ chart, key });
  }
  return due;
}

/**
 * Runs the due rooms one after another (D1, 4H, 1H). Each room is independent of the others
 * (owner decisions 2026-11-09: no room reads another timeframe); one at a time keeps the model's
 * per-minute burst to one room (production 2026-11-06: three rooms in parallel hit the Workers AI
 * per-minute limit). Each room is idempotent per bar; a room cut short is finished by the next sweep.
 */
export async function runPendingTimeframeThreads(env, { now = Date.now(), clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRoom = null } = {}) {
  if (!tfThreadsEnabled(env)) return { status: "disabled" };
  const order = ["D1", "H4", "H1"];
  const due = (await dueBars(env, now)).sort((a, b) => order.indexOf(a.chart) - order.indexOf(b.chart));
  const out = {};
  let spent = false;
  for (const { chart, key } of due) {
    // Only a room that called the model spends the per-minute limit; a finished bar costs nothing.
    if (spent) await sleep(TF_ROOM_GAP_MS);
    try { out[chart] = await runTimeframeThread(env, { chart, candleKey: key }, { clock }); }
    catch (error) { out[chart] = { status: "error", error: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message.slice(0, 200) : null }; }
    spent = Number(out[chart]?.calls) > 0;
    // The H1 decision follows its room (owner decision 2026-11-07): the caller's Reasoner runs
    // as soon as the 1H room concludes. Its failure never stops the next room.
    const job = out[chart];
    if (onRoom) {
      try { await onRoom({ chart, key, result: out[chart] }); }
      catch (error) { out[chart] = { ...out[chart], on_room_error: error instanceof Error ? error.message.slice(0, 200) : String(error) }; }
    }
    // Aether A7: the shadow calls of approved notes run after the room's H1 decision.
    const shadow = await runShadowJob(job);
    if (shadow) out[chart] = { ...out[chart], shadow_knowledge: shadow };
  }
  return { status: "ok", charts: out };
}

/**
 * The latest 1H, 4H or D1 room for its Nexus tab: roster, bus, Consensus Discussion (the
 * `debate` field) and TLDR. With `candleKey`, the room of that bar (its latest session).
 */
export async function readTimeframeThread(db, chart, { candleKey = null, env = null } = {}) {
  const spec = TF_THREAD_CHARTS[chart];
  if (!spec) return null;
  await ensureThreadSchema(db);
  const threadId = `tf:${chart}`;
  const run = candleKey
    ? (await db.prepare("SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id = ? AND step = 'brief' AND json_extract(body_json, '$.candle_key') = ?").bind(threadId, candleKey).first())?.r
    : (await db.prepare("SELECT MAX(run_id) AS r FROM agent_thread_messages WHERE thread_id = ?").bind(threadId).first())?.r;
  if (!run) return null;
  const rows = ((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? ORDER BY id").bind(threadId, run).all()).results || []).map(rowToThreadMessage);
  const brief = rows.find((m) => m.step === "brief");
  const order = new Map((brief?.roster || []).map((id, i) => [id, i]));
  const byRoster = (a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99);
  const note = (id) => {
    const c = brief?.calibration?.[id];
    if (!c) return null;
    if (c.total_lines == null) return c.label ?? null;
    return calibrationNote(c);
  };
  const pick = (m) => ({ id: m.agent, name: tfAgentName(m.agent), status: m.status, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, ts: m.ts, claim: m.claim ?? null, argument: m.argument ?? null, rebuts: m.rebuts ?? [], rebuts_names: (m.rebuts || []).map(tfAgentName), conceded: m.conceded === true, metrics: m.metrics ?? [], calibration: note(m.agent) });
  const openings = rows.filter((m) => m.step.startsWith("open:")).map(pick).sort(byRoster);
  const debate = rows.filter((m) => m.step.startsWith("debate:")).map(pick).sort(byRoster);
  const c = rows.find((m) => m.step === "conclusion");
  // P7 (RFC §7): each agent's 30-day track record on this chart (with caution flags from the open
  // H1 stuck states in the 1H room), and the room's crowd line.
  const rep = await roomReputationMap(env ?? { DB: db }, db, chart);
  let cautions = {};
  if (chart === "H1") { try { cautions = stuckCautions(await listStuckStates(db, { limit: 20 })); } catch { cautions = {}; } }
  const ids = [...new Set([...(brief?.roster || []), "moderator"])];
  return {
    reputation: roomReputation(ids, rep, cautions),
    crowd: c?.crowd ?? (openings.some((o) => o.status === "ok") ? buildCrowdLine(finalEntries(openings, debate), rep, await crowdOptions(env ?? { DB: db }, chart)) : null),
    tf: chart, tab: spec.tab, bar_open: barOpenOf(run), reconvened: String(run).includes("#"), bar_close: brief?.bar_time ?? rows[0]?.bar_time ?? null, candle_key: brief?.candle_key ?? null,
    phase: c?.status === "ok" ? "closed" : debate.length ? "debate" : "opening",
    confirmations: brief?.confirmations ?? null, hud_snapshot: brief?.hud_snapshot ?? null,
    roster: (brief?.roster || []).map((id) => ({ id, name: tfAgentName(id), calibration: note(id) })),
    conclusion: c ? { status: c.status, stance: c.stance, bias: c.bias ?? null, majority_bias: c.majority_bias ?? null, confidence: c.confidence, summary: c.summary ?? null, reasons: c.reasons ?? [], dissent: (c.dissent || []).map((id) => ({ id, name: tfAgentName(id) })), majority: c.majority ?? null, model: c.model ?? null, fallback_used: c.fallback_used === true, ...(c.status !== "ok" ? { errors: c.errors ?? [], primary_error: c.primary_error ?? null, raw: String(c.insight ?? "").slice(0, 300) } : {}) } : null,
    openings,
    debate
  };
}
