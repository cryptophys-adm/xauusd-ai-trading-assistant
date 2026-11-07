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
// Rules, as in the Live War Room: one role per agent and no repetition; HUD statements are
// marked verified only where they equal a parity-approved record, and an agent with no
// verified statement speaks at confidence <= 0.4; no confirmation, no entry (BUY or SELL needs
// that chart's Prophet R38 confirmation). Advisory only: stances are discussion positions, never
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
import { HUD_IDS, HUD_NAMES, calibrationCounts, calibrationNote, calibratedLines } from "./hud-reading.mjs";
import { loadHudSnapshot, hudReadings } from "./hud-store.mjs";
import { BUS_DEFAULT_MODEL, BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { ensureThreadSchema, rowToThreadMessage, ROOM_STANCES, hudEvidenceLines, threadInternals } from "./agent-threads.mjs";
import {
  validateOpening, validateRebuttal, majorityStance, selectRebutters, UNCALIBRATED_CONFIDENCE_CAP, BIAS_RULE, SUPPORT_RULE, stanceSupported,
  majorityBias, biasOfStance, biasSplitText, DECISION_BIAS_RULE, conclusionBiasErrors, agentIdsToNames,
  WAR_ROOM_OPENING_MS, WAR_ROOM_DEBATE_MS, WAR_ROOM_CONCLUSION_MS
} from "./war-room.mjs";
import { closedHtfCandleKeys, OBSERVED_PREFIX } from "./parity-sweep.mjs";
import { newsDeskEvidence } from "./news-daily.mjs";
import { chartDeskReading, chartDeskLabel } from "./timeframe-desk.mjs";

const { runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, clip, inUnit, parseJson } = threadInternals;

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
  htf: { name: "Higher-Timeframe Desk", role: "the conclusion of the next higher timeframe's Thread: the backdrop this timeframe trades in" },
  news: { name: "News Analyst", role: "the fundamental news of the last 24 hours: the daily bias for gold and the headlines behind it" },
  technical: { name: "Technical Analyst", role: "price action only: the last closed candles of this chart" },
  risk: { name: "Risk Manager", role: "risk only: volatility of this chart, conflicts with the higher timeframe and the news, what would invalidate a move, and the rule no confirmation, no entry" }
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
  if (HUD_NAMES[id]) return HUD_NAMES[id];
  return id === "moderator" ? "Moderator" : String(id);
}

/** No confirmation, no entry: BUY or SELL needs that chart's Prophet R38 confirmation. */
export function tfEntryAllowed(stance, confirmations) {
  if (stance !== "BUY" && stance !== "SELL") return true;
  return confirmations?.chart_prophet_r38?.[stance === "BUY" ? "buy_confirmed" : "sell_confirmed"] === true;
}
const ruleText = (spec) =>
  `Rule: no confirmation, no entry. BUY needs a confirmed buy signal of the ${spec.label} Prophet R38; SELL needs a confirmed sell signal. Without the matching confirmation the stance is WAIT, or HOLD / CLOSE for a position already open.`;

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
 * BUY or SELL needs the chart's confirmation; on 1H a stance that differs from the H1 decision
 * must name it.
 */
export function validateTfConclusion(o, { busAgents = [], confirmations = null, h1Decision = null, supportStances = null, supportBiases = null, roomBias = "NEUTRAL" } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  agentIdsToNames(o, busAgents, tfAgentName);
  const errors = [];
  if (!ROOM_STANCES.includes(o.stance)) errors.push("stance_invalid");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.summary !== "string" || !o.summary.trim()) errors.push("summary_missing");
  else {
    errors.push(...naturalLanguageErrors(o.summary));
    const h1 = h1Decision ? String(h1Decision).toUpperCase() : null;
    if (h1 && ROOM_STANCES.includes(o.stance) && o.stance !== h1 && !new RegExp(`H1[^.]{0,40}${h1}`, "i").test(o.summary)) errors.push("h1_reference_missing");
  }
  if (confirmations && !tfEntryAllowed(o.stance, confirmations)) errors.push("entry_without_confirmation");
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

/** The latest conclusion of a timeframe's Thread, for the desk one timeframe below. */
async function latestConclusion(db, chart) {
  let row = null;
  try { row = await db.prepare("SELECT run_id, stance, confidence, body_json FROM agent_thread_messages WHERE thread_id = ? AND step = 'conclusion' AND status = 'ok' ORDER BY run_id DESC LIMIT 1").bind(`tf:${chart}`).first(); } catch { row = null; }
  if (!row) return null;
  const body = parseJson(row.body_json, {}) || {};
  return { timeframe: TF_THREAD_CHARTS[chart].label, bar_open: barOpenOf(row.run_id), stance: row.stance, bias: body.bias ?? null, confidence: row.confidence, summary: body.summary ?? null };
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
  const funnel = snapshot?.huds?.r37_funnel?.fields || null;
  const confirmations = {
    chart_prophet_r38: {
      buy_confirmed: (r38?.buy_confirmed ?? funnel?.buy_confirmed) === true,
      sell_confirmed: (r38?.sell_confirmed ?? funnel?.sell_confirmed) === true,
      approved_by_parity: prophet?.approved === true,
      source: r38 ? "the local Prophet R38 record of this bar" : funnel ? "the R37 funnel HUD of this bar" : "not available"
    }
  };

  const higher = spec.higher ? await latestConclusion(db, spec.higher) : null;
  const news = await newsDeskEvidence(db);
  let desk = { available: false, reading: [], approved_by_parity: false };
  try { desk = await chartDeskReading(env, candleKey); } catch { /* no desk reading this bar */ }
  return {
    chart, candle_key: candleKey, bar_open: last.open_time, bar_close: last.close_time,
    technical: { candles, average_range_14: round(ranges.reduce((a, b) => a + b, 0) / Math.max(ranges.length, 1)) },
    hud, confirmations, higher, news, desk
  };
}

function agentData(agent, ev, spec) {
  switch (agent) {
    case "h1": case "h4": case "d1": return { timeframe: spec.label, reading: ev.desk.reading, approved_by_parity: ev.desk.approved_by_parity };
    case "htf": return ev.higher;
    case "news": return ev.news;
    case "technical": return { timeframe: spec.label, closed_candles: ev.technical.candles };
    case "risk": return {
      timeframe: spec.label, ranges: ev.technical.candles.map((c) => round(c.h - c.l)), average_range_14: ev.technical.average_range_14,
      higher_timeframe: ev.higher ? { stance: ev.higher.stance, timeframe: ev.higher.timeframe } : null,
      news_bias: ev.news?.consensus ?? null, confirmations: ev.confirmations
    };
    default: return { hud: HUD_NAMES[agent], timeframe: spec.label, reading: hudEvidenceLines(ev.hud?.readings?.[agent]) };
  }
}

const deskList = (roster) => roster.filter((id) => TF_DESKS[id]).map((id) => `the ${TF_DESKS[id].name}`).join(", ");

function openingMessages(agent, data, spec, roster) {
  const desk = TF_DESKS[agent];
  const riskRule = agent === "risk" ? [ruleText(spec) + " Judge every possible entry against the confirmations in your data, and say plainly whether any entry is confirmed."] : [];
  const who = desk
    ? `You are the ${desk.name} in the XAUUSD ${spec.label} War Room, which meets at every closed ${spec.label} candle. Your only role: ${desk.role}.`
    : `You are ${HUD_NAMES[agent]}, one agent per Pine HUD, in the XAUUSD ${spec.label} War Room. You speak only about the ${HUD_NAMES[agent]} HUD on the ${spec.label} candle that just closed. Lean on the statements marked verified by parity or computed from verified bars. The readers already see your calibration status once, next to your name: never mention calibration, verification or comparators in your claim. When every statement is not yet calibrated, keep your confidence at or below ${UNCALIBRATED_CONFIDENCE_CAP}.`;
  return chatMessages([
    who,
    RULES_NO_REFS,
    ROOM_RULES,
    ...riskRule,
    `This is your opening on the communication bus: one claim from your own data only. Do not repeat what other roles cover (the other agents are ${deskList(roster)} and one agent per HUD).`,
    BIAS_RULE,
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"claim":"<= ${CLAIM_MAX - 40} chars"}`,
    "YOUR DATA:",
    JSON.stringify(data ?? { available: false })
  ]);
}

function rebuttalMessages(agent, own, bus, spec, unanimous, confirmations, roomBias = null) {
  const riskRule = agent === "risk" ? [ruleText(spec) + " Rebut every agent on the bus that proposes BUY or SELL without the matching confirmation. CONFIRMATIONS: " + JSON.stringify(confirmations)] : [];
  return chatMessages([
    `You are ${tfAgentName(agent)} in the XAUUSD ${spec.label} War Room Consensus Discussion${TF_DESKS[agent] ? " (" + TF_DESKS[agent].role + ")" : ""}. The Consensus Discussion is open for at most 3 minutes.`,
    RULES_NO_REFS,
    ROOM_RULES,
    unanimous && roomBias && agent !== "risk"
      ? biasSplitText(roomBias)
      : unanimous
        ? "The bus is unanimous. Stress-test the consensus: challenge the claim most likely to be wrong, put that agent's id in rebuts, and say what would invalidate the consensus. Add only new reasoning from your own role; never restate a claim."
        : "Rebut the strongest claims you disagree with and put those agents' ids in rebuts. Add only new reasoning from your own role; never restate your opening or another agent's claim. You may change your stance or your bias if the bus convinced you: then put the ids of the agents who convinced you in rebuts (or leave it empty), never your own id.",
    ...riskRule,
    "In the argument, call agents by their names, never by an id. Each bus entry says how much of that agent's data is verified by parity or computed from verified bars: weigh that evidence above uncalibrated readings, and never discuss calibration itself.",
    `Required JSON: {"agent":"${agent}","stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"rebuts":["<agent id>"],"argument":"<= ${ARGUMENT_MAX - 40} chars"}`,
    "YOUR OPENING: " + JSON.stringify({ stance: own.stance, bias: own.bias ?? null, confidence: own.confidence, claim: own.claim }),
    "COMMUNICATION BUS (id, name, stance, bias, confidence, evidence, claim):",
    JSON.stringify(bus)
  ]);
}

function conclusionMessages(spec, bus, debate, confirmations) {
  return chatMessages([
    `You are the moderator of the XAUUSD ${spec.label} War Room. The Consensus Discussion is closed. Write the TLDR of the ${spec.label} Thread: the consensus of the room on this timeframe.${spec.tab === "1H" ? " The Reasoner writes the H1 decision after you, from this room's consensus." : ""}`,
    RULES_NO_REFS,
    ROOM_RULES,
    ruleText(spec) + " The conclusion obeys it: BUY or SELL only with the matching confirmation below. CONFIRMATIONS: " + JSON.stringify(confirmations),
    SUPPORT_RULE,
    DECISION_BIAS_RULE + " A BULLISH or BEARISH bias needs at least one agent holding it.",
    "Weigh claims by their argument and by their evidence, not by the number of agents: a claim built on data verified by parity, or computed from verified bars, outweighs one built on uncalibrated readings (each bus entry states which). No repetition: the summary states the conclusion once, each reason adds something new, and dissent lists the ids of agents whose stance or bias still differs from yours. In the summary and reasons, call agents by their names, never by an id, and never discuss calibration itself.",
    'Required JSON: {"stance":"BUY|SELL|HOLD|WAIT|CLOSE","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"summary":"<= 360 chars","reasons":["<= 160 chars", "at most 3"],"dissent":["<agent id>"]}',
    "COMMUNICATION BUS:",
    JSON.stringify(bus),
    "CONSENSUS DISCUSSION:",
    JSON.stringify(debate)
  ]);
}

/** Runs the War Room of one closed 1H, 4H or D1 bar; idempotent per bar. */
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
  const roster = [
    ...(ownDesk ? [ownDesk] : []), ...(ev.higher ? ["htf"] : []), ...(ev.news ? ["news"] : []), "technical", "risk",
    ...HUD_IDS.filter((id) => ev.hud?.readings?.[id]?.available)
  ];
  const calibration = Object.fromEntries(roster.map((id) => {
    const lines = ev.hud?.readings?.[id]?.lines;
    if (Array.isArray(lines)) return [id, calibrationCounts(lines)];
    if (id === "h1" || id === "h4" || id === "d1") return [id, { label: chartDeskLabel(spec.tab, ev.desk) }];
    if (id === "htf") return [id, { label: `the ${ev.higher.timeframe} Thread` }];
    if (id === "news") return [id, { label: "news of the last 24 hours" }];
    return [id, { label: `closed ${spec.label} bars` }];
  }));
  const evidenceNote = (id) => {
    const c = calibration[id] || {};
    if (c.total_lines == null) return c.label || null;
    return calibrationNote(c, "no statement calibrated yet");
  };
  const base = (step, agent, parent_id = null) => ({ thread_id: threadId, run_id: runId, step, agent, parent_id, bar_time: ev.bar_close });
  if (!existing.has("brief")) {
    await writeMessage(db, { ...base("brief", "system"), ts: new Date(clock()).toISOString(), status: "info", body: {
      chart, candle_key: candleKey, roster, calibration, confirmations: ev.confirmations, bar: ev.technical.candles.at(-1) ?? null,
      hud_snapshot: Boolean(ev.hud),
      higher: ev.higher ? { timeframe: ev.higher.timeframe, stance: ev.higher.stance } : null, news: ev.news ? { consensus: ev.news.consensus } : null
    } });
  }

  const roomEnv = env;
  const maxPerHour = Number(env.TF_THREADS_MAX_CALLS_PER_HOUR ?? 120);
  let remaining = 0;
  try { remaining = (Number.isFinite(maxPerHour) ? maxPerHour : 0) - (await callsInLastHour(db, clock(), "tf")); } catch { remaining = 0; }
  let calls = 0;
  const phase = (ms) => {
    const deadline = clock() + ms;
    const runState = { primaryError: null };
    const budgetOk = async () => clock() < deadline && remaining-- > 0;
    return (stepBase, opts) => { calls += 1; return runStep(roomEnv, db, stepBase, { ...opts, deadline, clock, runState, budgetOk }); };
  };

  // Phase 1: the communication bus.
  const open = phase(WAR_ROOM_OPENING_MS);
  const openings = await Promise.all(roster.map((agent) => {
    const prior = existing.get("open:" + agent);
    if (prior?.status === "ok") return prior;
    return open(base("open:" + agent, agent), {
      messages: openingMessages(agent, agentData(agent, ev, spec), spec, roster), schemaName: "tf_room_opening", schema: OPENING_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low",
      // A timeframe desk whose records parity has not approved speaks at 0.4 or lower.
      validate: (o) => validateOpening(normalizeTfNames(o, [agent]), agent, { verifiedLines: (agent === "h1" || agent === "h4" || agent === "d1") ? (ev.desk?.approved_by_parity ? null : 0) : calibration[agent]?.total_lines == null ? null : calibratedLines(calibration[agent]) }),
      toBody: (o) => ({ body: { claim: clip(o.claim, CLAIM_MAX), bias: o.bias, name: tfAgentName(agent) }, refs: [] })
    });
  }));
  const answered = openings.filter((m) => m?.status === "ok");
  if (!answered.length) return { status: "no_openings", calls };
  const young = clock() - Date.parse(ev.bar_close) < TF_QUORUM_WAIT_MS;
  if (young && answered.length * 2 < roster.length) return { status: "waiting_for_quorum", calls, openings: answered.length, roster: roster.length };
  const bus = answered.map((m) => ({ id: m.agent, name: tfAgentName(m.agent), stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, evidence: evidenceNote(m.agent), claim: m.claim }));
  const busAgents = bus.map((b) => b.id);

  // Phase 2: the Consensus Discussion, open for at most 3 minutes.
  const majority = majorityStance(answered, ev.higher?.stance ?? "WAIT");
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
      messages: rebuttalMessages(agent, own, bus, spec, unanimous, ev.confirmations, biasSplit), schemaName: "tf_room_rebuttal", schema: REBUTTAL_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low",
      validate: (o) => validateRebuttal(normalizeTfNames(o, busAgents), agent, busAgents, { unanimous, ownStance: own?.stance ?? null, ownBias: own?.bias ?? null }),
      toBody: (o) => ({ body: { argument: clip(o.argument, ARGUMENT_MAX), bias: o.bias, rebuts: [...new Set(o.rebuts)].slice(0, 4), ...(o.conceded ? { conceded: true } : {}), name: tfAgentName(agent) }, refs: [] })
    });
  }))).filter((m) => m?.status === "ok");

  // Phase 3: the TLDR of this timeframe.
  const conclude = phase(WAR_ROOM_CONCLUSION_MS);
  await conclude(base("conclusion", "moderator"), {
    messages: conclusionMessages(spec, bus, debate.map((m) => ({ id: m.agent, name: tfAgentName(m.agent), stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, rebuts: m.rebuts, argument: m.argument })), ev.confirmations),
    schemaName: "tf_room_conclusion", schema: CONCLUSION_SCHEMA, maxTokens: BUS_MAX_TOKENS.moderator, effort: "low",
    validate: (o) => validateTfConclusion(o, { busAgents, confirmations: ev.confirmations, supportStances: new Set([...answered.map((m) => m.stance), ...debate.map((m) => m.stance)]), supportBiases: new Set([...answered, ...debate].map((m) => m.bias || biasOfStance(m.stance))), roomBias }),
    toBody: (o) => ({ body: { summary: clip(o.summary, 400), bias: o.bias, reasons: o.reasons.slice(0, 3).map((r) => clip(r, 200)), dissent: [...new Set(o.dissent)], majority, majority_bias: roomBias }, refs: [] })
  });
  return { status: "complete", calls, openings: answered.length, rebuttals: debate.length, ...(reconvened ? { reconvened: true } : {}) };
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
    let snapshot = null;
    try { snapshot = await env.SIGNAL_CACHE?.get?.(`hud:${period}:${key}`); } catch { snapshot = null; }
    if (!snapshot && now - closeMs < TF_HUD_WAIT_MS) continue;
    due.push({ chart, key });
  }
  return due;
}

/**
 * Runs the due rooms one after another, the higher timeframe first (D1, 4H, 1H): each room's
 * Higher-Timeframe Desk then reads the conclusion just written above it, and the model sees one
 * room's burst at a time (production 2026-11-06: three rooms in parallel hit the Workers AI
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
    if (onRoom) {
      try { await onRoom({ chart, key, result: out[chart] }); }
      catch (error) { out[chart] = { ...out[chart], on_room_error: error instanceof Error ? error.message.slice(0, 200) : String(error) }; }
    }
  }
  return { status: "ok", charts: out };
}

/**
 * The latest 1H, 4H or D1 room for its Nexus tab: roster, bus, Consensus Discussion (the
 * `debate` field) and TLDR. With `candleKey`, the room of that bar (its latest session).
 */
export async function readTimeframeThread(db, chart, { candleKey = null } = {}) {
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
  const pick = (m) => ({ id: m.agent, name: tfAgentName(m.agent), status: m.status, stance: m.stance, bias: m.bias ?? null, confidence: m.confidence, ts: m.ts, claim: m.claim ?? null, argument: m.argument ?? null, rebuts: m.rebuts ?? [], rebuts_names: (m.rebuts || []).map(tfAgentName), conceded: m.conceded === true, calibration: note(m.agent) });
  const openings = rows.filter((m) => m.step.startsWith("open:")).map(pick).sort(byRoster);
  const debate = rows.filter((m) => m.step.startsWith("debate:")).map(pick).sort(byRoster);
  const c = rows.find((m) => m.step === "conclusion");
  return {
    tf: chart, tab: spec.tab, bar_open: barOpenOf(run), reconvened: String(run).includes("#"), bar_close: brief?.bar_time ?? rows[0]?.bar_time ?? null, candle_key: brief?.candle_key ?? null,
    phase: c?.status === "ok" ? "closed" : debate.length ? "debate" : "opening",
    confirmations: brief?.confirmations ?? null, hud_snapshot: brief?.hud_snapshot ?? null,
    roster: (brief?.roster || []).map((id) => ({ id, name: tfAgentName(id), calibration: note(id) })),
    conclusion: c ? { status: c.status, stance: c.stance, bias: c.bias ?? null, majority_bias: c.majority_bias ?? null, confidence: c.confidence, summary: c.summary ?? null, reasons: c.reasons ?? [], dissent: (c.dissent || []).map((id) => ({ id, name: tfAgentName(id) })), majority: c.majority ?? null, model: c.model ?? null, fallback_used: c.fallback_used === true, ...(c.status !== "ok" ? { errors: c.errors ?? [], primary_error: c.primary_error ?? null, raw: String(c.insight ?? "").slice(0, 300) } : {}) } : null,
    openings,
    debate
  };
}
