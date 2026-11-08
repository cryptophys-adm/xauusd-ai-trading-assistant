// Macro War Room (owner decisions 2026-11-08): the market correlations become a room that discusses
// the news and the scheduled events that move gold. It meets 20 minutes after every 4-hour close
// (after the timeframe rooms' burst) and once 30 minutes after a High-impact USD event, in the same
// three phases as the other rooms:
//   1. Communication bus: every agent opens with one claim from its own data only;
//   2. Consensus Discussion: the agents whose bias differs from the room's answer named agents;
//   3. Conclusion: the moderator writes the macro bias for gold over the next 4 to 24 hours.
// Agents: the Calendar Agent (the fixed-rule projections of src/calendar-agent.mjs; it may explain
// them but never reverse them), the News Analyst, the Dollar Analyst (DXY), the Rates Analyst (US
// 10-year yield), the Metals Analyst (silver), the Oil Analyst (WTI crude and the geopolitical
// headlines, owner request 2026-11-08) and the Correlation Analyst (whether the usual links hold). Context only (owner decision): the News Analyst of every room reads the conclusion and
// the Global decision shows it as a MACRO row; it never changes the strategy engine's decision.
// Advisory only: no price level, no order, no position size. Behind MACRO_ROOM_ENABLED, within
// MACRO_ROOM_MAX_CALLS_PER_HOUR.
import { chatMessages } from "./model-text.mjs";
import { naturalLanguageErrors } from "./natural-language.mjs";
import { BUS_MAX_TOKENS } from "./multi-agent-bus.mjs";
import { ensureThreadSchema, rowToThreadMessage, threadInternals } from "./agent-threads.mjs";
import { readCorrelations } from "./correlations.mjs";
import { cachedCalendar } from "./econ-calendar.mjs";
import { calendarOutlook } from "./calendar-agent.mjs";
import { readNewsDaily } from "./news-daily.mjs";

const { runStep, writeMessage, upsertThread, callsInLastHour, RULES_NO_REFS, clip, inUnit } = threadInternals;

export const MACRO_ROOM_VERSION = "cryptophys.macro-room.v1";
export const MACRO_THREAD = "macro:XAUUSD";
export const MACRO_BIASES = Object.freeze(["BULLISH", "BEARISH", "NEUTRAL"]);
export const MACRO_AGENTS = Object.freeze({
  calendar: { name: "Calendar Agent", role: "the scheduled US events: the projected effect of each on gold by fixed rules, and the headlines after a release" },
  news: { name: "News Analyst", role: "the fundamental news of the last 24 hours: the daily bias for gold and the headlines behind it" },
  dollar: { name: "Dollar Analyst", role: "the US Dollar Index: its recent move and how tightly it has moved against gold" },
  rates: { name: "Rates Analyst", role: "the US 10-year yield: its recent move and what it means for the cost of holding gold" },
  silver: { name: "Metals Analyst", role: "silver: whether it confirms or contradicts gold's move" },
  // Owner request 2026-11-08: oil is the geopolitical and inflation channel.
  oil: { name: "Oil Analyst", role: "WTI crude oil and the geopolitical headlines: oil as the channel through which supply shocks and conflict feed inflation and safe-haven demand" },
  correlation: { name: "Correlation Analyst", role: "whether the usual links between gold, the dollar, yields, silver and oil hold now or have broken" }
});
const ROSTER = Object.keys(MACRO_AGENTS);
const H4 = 4 * 3_600_000;
/** The 4-hour session waits for the timeframe rooms' burst; the event session for the first reaction. */
export const AFTER_4H_CLOSE_MS = 20 * 60_000;
export const AFTER_EVENT_MS = 30 * 60_000;
const SESSION_WINDOW_MS = 3 * 3_600_000;
const MAX_REBUTTALS = 4;
const CLAIM_MAX = 320, ARGUMENT_MAX = 420;

export function macroRoomEnabled(env) {
  return String(env?.MACRO_ROOM_ENABLED || "").toLowerCase() === "true";
}
export const macroAgentName = (id) => MACRO_AGENTS[id]?.name ?? String(id);
const side = (x) => (x > 0.1 ? "BULLISH" : x < -0.1 ? "BEARISH" : "NEUTRAL");
// The same phase limits as the other rooms (src/war-room.mjs; not imported, because the rooms import
// this module for the macro conclusion).
const OPENING_MS = 90_000, DEBATE_MS = 180_000, CONCLUSION_MS = 60_000;
const DIR = { BULLISH: 1, BEARISH: -1, NEUTRAL: 0 };
/** Pure: the confidence-weighted bias of the bus (NEUTRAL inside +/-0.1), as in the other rooms. */
export function macroMajorityBias(openings) {
  let sum = 0, weight = 0;
  for (const o of openings || []) { const c = inUnit(o?.confidence) ? o.confidence : 0.5; sum += (DIR[o?.bias] ?? 0) * c; weight += c; }
  return side(weight ? sum / weight : 0);
}

/**
 * Pure: the sessions due at `now`: the latest closed 4-hour gold bar (from 20 minutes after its close,
 * for 3 hours) and every High-impact USD event released 30 minutes to 3 hours ago. Events at the
 * same minute share one session. `done` holds the run ids already concluded.
 */
export function dueSessions({ goldLastClose = null, events = [], now = Date.now(), done = new Set() } = {}) {
  const out = [];
  const t4 = Date.parse(goldLastClose ?? "");
  if (Number.isFinite(t4) && now >= t4 + AFTER_4H_CLOSE_MS && now <= t4 + SESSION_WINDOW_MS) out.push({ run_id: `4h:${new Date(t4).toISOString()}`, kind: "4h", at: new Date(t4).toISOString() });
  const times = new Set();
  for (const e of events || []) {
    if (e?.currency !== "USD" || e?.impact !== "High") continue;
    const t = Date.parse(e.time);
    if (Number.isFinite(t) && now >= t + AFTER_EVENT_MS && now <= t + SESSION_WINDOW_MS) times.add(t);
  }
  for (const t of [...times].sort()) out.push({ run_id: `event:${new Date(t).toISOString()}`, kind: "event", at: new Date(t).toISOString() });
  return out.filter((s) => !done.has(s.run_id));
}

/**
 * Pure: the bias the Calendar Agent must hold. Before a release it follows the fixed-rule consensus
 * lean (it explains it, never reverses it); within 4 hours after a release it reads the headlines
 * and is free. Null means free.
 */
export function calendarBiasRule(outlook) {
  if (!outlook?.events?.length) return "NEUTRAL";
  if (outlook.events.some((p) => p.status === "released")) return null;
  return side(outlook.consensus_lean);
}

const assetData = (row, rule) => row ? {
  market: row.name, available: row.available,
  change: { last_4_hours: row.change?.["4h"] ?? null, last_day: row.change?.["1d"] ?? null, last_5_days: row.change?.["5d"] ?? null, unit: row.unit === "bp" ? "basis points" : "percent" },
  correlation_with_gold: { week: row.correlation?.short ?? null, month: row.correlation?.long ?? null },
  rule
} : { available: false };

/** Words of the news headlines that carry oil supply or geopolitical risk. */
export const GEOPOLITICAL = /\b(oil|crude|brent|wti|opec|energy|gas|pipeline|refiner\w*|sanction\w*|embargo|tariff\w*|war|conflict|attack\w*|strike\w*|missile\w*|drone\w*|ceasefire|geopolit\w*|iran\w*|israel\w*|gaza|hezbollah|houthi\w*|red sea|hormuz|russia\w*|ukrain\w*|middle east|saudi|venezuela\w*|china|taiwan)\b/i;
/** Pure: up to six News Daily headlines on oil or geopolitics, with their bias for gold. */
export function geopoliticalHeadlines(daily) {
  return (daily?.items || []).filter((i) => typeof i?.title === "string" && GEOPOLITICAL.test(i.title)).slice(0, 6).map((i) => ({ title: i.title, bias: i.bias ?? null }));
}

/** The evidence of one session: correlations, the calendar outlook, the news and the post-release headlines. */
export async function macroEvidence(env, { now = Date.now(), at = null } = {}) {
  let corr = null;
  try { corr = await readCorrelations(env, { now }); } catch { corr = null; }
  let outlook = null;
  try { outlook = calendarOutlook((await cachedCalendar(env))?.events || [], now); } catch { outlook = null; }
  let daily = null;
  try { daily = await readNewsDaily(env.DB); } catch { daily = null; }
  const released = (outlook?.events || []).filter((p) => p.status === "released").map((p) => Date.parse(p.time));
  const since = released.length ? Math.min(...released) - 15 * 60_000 : null;
  const headlinesAfter = since ? (daily?.items || []).filter((i) => Date.parse(i.published_at) >= since).slice(0, 8).map((i) => ({ title: i.title, bias: i.bias ?? null })) : [];
  const asset = (id) => corr?.assets?.find((a) => a.id === id) ?? null;
  const news = daily?.tldr?.status === "ok" ? { window: "the last 24 hours", consensus: daily.tldr.stance, confidence: daily.tldr.confidence, summary: daily.tldr.summary, reasons: daily.tldr.reasons, counts: daily.counts, headlines: (daily.items || []).filter((i) => i.bias).slice(0, 6).map((i) => ({ title: i.title, bias: i.bias })) } : null;
  return {
    at, gold_last_close: corr?.gold?.last_close_time ?? null, outlook,
    data: {
      calendar: outlook ? { summary: outlook.summary, consensus_lean: outlook.consensus_lean, events: outlook.events.map((p) => ({ title: p.title, time: p.time, status: p.status, projection: p.text })), headlines_after_release: headlinesAfter } : { available: false },
      news: news ?? { available: false },
      dollar: assetData(asset("dxy"), "A stronger dollar usually weighs on gold; a weaker dollar supports it."),
      rates: assetData(asset("us10y"), "Higher yields raise the cost of holding gold, which pays no interest; falling yields support it."),
      silver: assetData(asset("silver"), "Silver moving with gold confirms a metals move; silver diverging weakens it."),
      oil: (() => {
        const d = assetData(asset("oil"), "Oil is the geopolitical and inflation channel. A supply shock or conflict that lifts oil raises inflation expectations and safe-haven demand, which usually supports gold; if the same rise pushes yields and Fed expectations higher, that weighs on gold. Falling oil eases inflation pressure.");
        return d.available === false ? d : { ...d, geopolitical_headlines: geopoliticalHeadlines(daily) };
      })(),
      correlation: corr ? { gold_change: { last_4_hours: corr.gold?.change?.["4h"] ?? null, last_day: corr.gold?.change?.["1d"] ?? null, last_5_days: corr.gold?.change?.["5d"] ?? null }, links: (corr.assets || []).map((a) => ({ market: a.name, week: a.correlation?.short ?? null, month: a.correlation?.long ?? null })), note: "Gold usually moves against the dollar and yields and with silver; oil links to gold through inflation and geopolitical risk; a week that differs from the month means the link is changing." } : { available: false }
    }
  };
}

const RULES = [
  "The bias is your view of gold's direction over the next 4 to 24 hours from your role only: BULLISH (gold up), BEARISH (gold down) or NEUTRAL (no clear effect, or mixed).",
  "Say it in plain words. Never give a price level, an entry, a stop, a target, a position size or an order. Context only: this room never decides a trade."
].join("\n");
const OPENING_SCHEMA = Object.freeze({ type: "object", additionalProperties: false, properties: { agent: { type: "string" }, bias: { type: "string", enum: [...MACRO_BIASES] }, confidence: { type: "number" }, claim: { type: "string" } }, required: ["agent", "bias", "confidence", "claim"] });
const REBUTTAL_SCHEMA = Object.freeze({ type: "object", additionalProperties: false, properties: { agent: { type: "string" }, bias: { type: "string", enum: [...MACRO_BIASES] }, confidence: { type: "number" }, rebuts: { type: "array", items: { type: "string" } }, argument: { type: "string" } }, required: ["agent", "bias", "confidence", "rebuts", "argument"] });
const CONCLUSION_SCHEMA = Object.freeze({ type: "object", additionalProperties: false, properties: { bias: { type: "string", enum: [...MACRO_BIASES] }, confidence: { type: "number" }, summary: { type: "string" }, reasons: { type: "array", items: { type: "string" } }, drivers: { type: "array", items: { type: "string" } } }, required: ["bias", "confidence", "summary", "reasons", "drivers"] });

/** Pure: an opening; `requiredBias` is the Calendar Agent's fixed-rule bias (null = free). */
export function validateMacroOpening(o, agent, { requiredBias = null } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  if (o.agent !== agent) errors.push("agent_mismatch");
  if (!MACRO_BIASES.includes(o.bias)) errors.push("bias_invalid");
  if (requiredBias && o.bias !== requiredBias) errors.push(`calendar_projection_reversed:${requiredBias}`);
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.claim !== "string" || !o.claim.trim()) errors.push("claim_missing");
  else errors.push(...naturalLanguageErrors(o.claim));
  o.stance = o.bias;
  return { valid: errors.length === 0, errors };
}

/** Pure: a rebuttal names other bus agents only. */
export function validateMacroRebuttal(o, agent, busAgents, { requiredBias = null } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  if (o.agent !== agent) errors.push("agent_mismatch");
  if (!MACRO_BIASES.includes(o.bias)) errors.push("bias_invalid");
  if (requiredBias && o.bias !== requiredBias) errors.push(`calendar_projection_reversed:${requiredBias}`);
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (!Array.isArray(o.rebuts) || o.rebuts.some((id) => id === agent || !busAgents.includes(id))) errors.push("rebuts_invalid");
  if (typeof o.argument !== "string" || !o.argument.trim()) errors.push("argument_missing");
  else errors.push(...naturalLanguageErrors(o.argument));
  o.stance = o.bias;
  return { valid: errors.length === 0, errors };
}

/** Pure: the conclusion's bias must be held by at least one agent (NEUTRAL always stands). */
export function validateMacroConclusion(o, { busAgents = [], supportBiases = new Set() } = {}) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { valid: false, errors: ["not_an_object"] };
  const errors = [];
  if (!MACRO_BIASES.includes(o.bias)) errors.push("bias_invalid");
  else if (o.bias !== "NEUTRAL" && !supportBiases.has(o.bias)) errors.push("bias_without_support");
  if (!inUnit(o.confidence)) errors.push("confidence_out_of_range");
  if (typeof o.summary !== "string" || !o.summary.trim()) errors.push("summary_missing");
  else errors.push(...naturalLanguageErrors(o.summary));
  if (Array.isArray(o.reasons)) o.reasons = o.reasons.filter((r) => !(typeof r === "string" && !r.trim()));
  if (!Array.isArray(o.reasons) || o.reasons.length < 1 || o.reasons.some((r) => typeof r !== "string")) errors.push("reasons_invalid");
  else for (const r of o.reasons.slice(0, 3)) errors.push(...naturalLanguageErrors(r));
  if (!Array.isArray(o.drivers) || o.drivers.some((d) => !busAgents.includes(d))) errors.push("drivers_invalid");
  o.stance = o.bias;
  return { valid: errors.length === 0, errors };
}

function openingMessages(agent, data, session, requiredBias) {
  const a = MACRO_AGENTS[agent];
  const calendarRule = agent === "calendar"
    ? [requiredBias
      ? `The projections come from fixed rules and you explain them; you never reverse them. Your bias is ${requiredBias}.`
      : "An event was just released: read its outcome from the headlines after the release, against the projection, and say whether the surprise pointed gold up or down."]
    : [];
  return chatMessages([
    `You are the ${a.name} in the XAUUSD Macro War Room, which discusses the news and the scheduled events that move gold. This session: ${session.kind === "event" ? "30 minutes after a high-impact US event" : "after a 4-hour close"}. Your only role: ${a.role}.`,
    RULES_NO_REFS,
    RULES,
    ...calendarRule,
    "This is your opening on the communication bus: one claim from your own data only. Do not repeat what the other roles cover.",
    `Required JSON: {"agent":"${agent}","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"claim":"<= ${CLAIM_MAX - 40} chars"}`,
    "YOUR DATA:",
    JSON.stringify(data ?? { available: false })
  ]);
}

function rebuttalMessages(agent, own, bus, roomBias, requiredBias) {
  return chatMessages([
    `You are the ${macroAgentName(agent)} in the XAUUSD Macro War Room Consensus Discussion (${MACRO_AGENTS[agent].role}). The room leans ${roomBias}.`,
    RULES_NO_REFS,
    RULES,
    ...(requiredBias ? [`Your bias stays ${requiredBias}: the calendar projection comes from fixed rules.`] : []),
    "Answer the strongest claims you disagree with and put those agents' ids in rebuts. Add only new reasoning from your own role; never restate a claim. You may change your bias if the bus convinced you. Call agents by their names in the argument, never by an id.",
    `Required JSON: {"agent":"${agent}","bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"rebuts":["<agent id>"],"argument":"<= ${ARGUMENT_MAX - 40} chars"}`,
    "YOUR OPENING: " + JSON.stringify({ bias: own.bias, confidence: own.confidence, claim: own.claim }),
    "COMMUNICATION BUS (id, name, bias, confidence, claim):",
    JSON.stringify(bus)
  ]);
}

function conclusionMessages(bus, debate) {
  return chatMessages([
    "You are the moderator of the XAUUSD Macro War Room. The Consensus Discussion is closed. Write the macro conclusion for gold: its likely direction over the next 4 to 24 hours from the news, the scheduled events, the dollar, yields and silver.",
    RULES_NO_REFS,
    RULES,
    "Weigh claims by their argument and their data, not by the number of agents: a released event's surprise or a central bank headline can outweigh several small moves. The Calendar Agent's projection comes from fixed rules; keep its direction when you cite it. A BULLISH or BEARISH conclusion needs at least one agent holding it. No repetition: the summary states the conclusion once and each reason adds something new. drivers lists the ids of the agents whose data drives the conclusion. Call agents by their names in the text, never by an id.",
    'Required JSON: {"bias":"BULLISH|BEARISH|NEUTRAL","confidence":0..1,"summary":"<= 360 chars","reasons":["<= 160 chars", "at most 3"],"drivers":["<agent id>"]}',
    "COMMUNICATION BUS:",
    JSON.stringify(bus),
    "CONSENSUS DISCUSSION:",
    JSON.stringify(debate)
  ]);
}

/** Runs one Macro War Room session; idempotent per run id. */
export async function runMacroRoom(env, session, { clock = () => Date.now(), now = clock() } = {}) {
  const db = env.DB;
  await ensureThreadSchema(db);
  await upsertThread(db, { id: MACRO_THREAD, kind: "macro", refKey: "XAUUSD", title: "Macro War Room · XAUUSD", post: null, now: clock() });
  const runId = session.run_id;
  const existing = new Map(((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ?").bind(MACRO_THREAD, runId).all()).results || []).map((r) => [r.step, rowToThreadMessage(r)]));
  if (existing.get("conclusion")?.status === "ok") return { status: "already_complete", calls: 0 };
  const ev = await macroEvidence(env, { now, at: session.at });
  const requiredBias = calendarBiasRule(ev.outlook);
  const roster = ROSTER.filter((id) => ev.data[id]?.available !== false);
  if (roster.length < 3) return { status: "not_enough_data", roster };
  const base = (step, agent, parent_id = null) => ({ thread_id: MACRO_THREAD, run_id: runId, step, agent, parent_id, bar_time: session.at });
  if (!existing.has("brief")) {
    await writeMessage(db, { ...base("brief", "system"), ts: new Date(clock()).toISOString(), status: "info", body: { version: MACRO_ROOM_VERSION, kind: session.kind, at: session.at, roster, calendar_bias_rule: requiredBias, calendar: ev.data.calendar?.summary ?? null } });
  }
  const maxPerHour = Number(env.MACRO_ROOM_MAX_CALLS_PER_HOUR ?? 30);
  let remaining = 0;
  try { remaining = (Number.isFinite(maxPerHour) ? maxPerHour : 0) - (await callsInLastHour(db, clock(), "macro")); } catch { remaining = 0; }
  let calls = 0;
  const phase = (ms) => {
    const deadline = clock() + ms;
    const runState = { primaryError: null };
    const budgetOk = async () => clock() < deadline && remaining-- > 0;
    return (stepBase, opts) => { calls += 1; return runStep(env, db, stepBase, { ...opts, deadline, clock, runState, budgetOk }); };
  };
  const ruleFor = (agent) => (agent === "calendar" ? requiredBias : null);

  // Phase 1: the communication bus.
  const open = phase(OPENING_MS);
  const openings = await Promise.all(roster.map((agent) => {
    const prior = existing.get("open:" + agent);
    if (prior?.status === "ok") return prior;
    return open(base("open:" + agent, agent), {
      messages: openingMessages(agent, ev.data[agent], session, ruleFor(agent)), schemaName: "macro_room_opening", schema: OPENING_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low",
      validate: (o) => validateMacroOpening(o, agent, { requiredBias: ruleFor(agent) }),
      toBody: (o) => ({ body: { claim: clip(o.claim, CLAIM_MAX), bias: o.bias, name: macroAgentName(agent) }, refs: [] })
    });
  }));
  const answered = openings.filter((m) => m?.status === "ok");
  if (answered.length * 2 < roster.length) return { status: "waiting_for_quorum", calls, openings: answered.length, roster: roster.length };
  const bus = answered.map((m) => ({ id: m.agent, name: macroAgentName(m.agent), bias: m.bias, confidence: m.confidence, claim: m.claim }));
  const busAgents = bus.map((b) => b.id);

  // Phase 2: the Consensus Discussion: the agents whose bias differs from the room's answer.
  const roomBias = macroMajorityBias(answered);
  let rebutters = answered.filter((m) => m.bias !== roomBias).sort((a, b) => b.confidence - a.confidence).map((m) => m.agent).slice(0, MAX_REBUTTALS);
  if (!rebutters.length && busAgents.includes("correlation")) rebutters = ["correlation"];
  const debateStep = phase(DEBATE_MS);
  const openingId = new Map(answered.map((m) => [m.agent, m.id]));
  const debate = (await Promise.all(rebutters.map((agent) => {
    const prior = existing.get("debate:" + agent);
    if (prior?.status === "ok") return prior;
    const own = answered.find((m) => m.agent === agent);
    return debateStep(base("debate:" + agent, agent, openingId.get(agent) ?? null), {
      messages: rebuttalMessages(agent, own, bus, roomBias, ruleFor(agent)), schemaName: "macro_room_rebuttal", schema: REBUTTAL_SCHEMA,
      maxTokens: BUS_MAX_TOKENS.agent, effort: "low",
      validate: (o) => validateMacroRebuttal(o, agent, busAgents, { requiredBias: ruleFor(agent) }),
      toBody: (o) => ({ body: { argument: clip(o.argument, ARGUMENT_MAX), bias: o.bias, rebuts: [...new Set(o.rebuts)].slice(0, 4), name: macroAgentName(agent) }, refs: [] })
    });
  }))).filter((m) => m?.status === "ok");

  // Phase 3: the macro conclusion.
  const supportBiases = new Set([...answered, ...debate].map((m) => m.bias));
  const conclude = phase(CONCLUSION_MS);
  const c = await conclude(base("conclusion", "moderator"), {
    messages: conclusionMessages(bus, debate.map((m) => ({ id: m.agent, name: macroAgentName(m.agent), bias: m.bias, confidence: m.confidence, rebuts: m.rebuts, argument: m.argument }))),
    schemaName: "macro_room_conclusion", schema: CONCLUSION_SCHEMA, maxTokens: BUS_MAX_TOKENS.moderator, effort: "low",
    validate: (o) => validateMacroConclusion(o, { busAgents, supportBiases }),
    toBody: (o) => ({ body: { summary: clip(o.summary, 400), bias: o.bias, reasons: o.reasons.slice(0, 3).map((r) => clip(r, 200)), drivers: [...new Set(o.drivers)], majority_bias: roomBias, horizon: "next 4 to 24 hours" }, refs: [] })
  });
  return { status: c?.status === "ok" ? "complete" : "no_conclusion", calls, openings: answered.length, rebuttals: debate.length };
}

/** Sweep step: runs the due sessions (at most one per sweep, the oldest first). Never throws. */
export async function runPendingMacroRooms(env, { now = Date.now(), clock = () => Date.now() } = {}) {
  if (!macroRoomEnabled(env) || !env?.DB) return { status: "disabled" };
  try {
    await ensureThreadSchema(env.DB);
    let corr = null;
    try { corr = await readCorrelations(env, { now }); } catch { corr = null; }
    const events = (await cachedCalendar(env))?.events || [];
    const rows = (await env.DB.prepare("SELECT DISTINCT run_id FROM agent_thread_messages WHERE thread_id = ? AND step = 'conclusion' AND status = 'ok' AND ts >= ?").bind(MACRO_THREAD, new Date(now - 2 * 86_400_000).toISOString()).all()).results || [];
    const due = dueSessions({ goldLastClose: corr?.gold?.last_close_time ?? null, events, now, done: new Set(rows.map((r) => r.run_id)) });
    if (!due.length) return { status: "idle" };
    const session = due[0];
    return { session: session.run_id, ...(await runMacroRoom(env, session, { clock, now })) };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

/** GET /api/macro: the latest session (concluded first), with its bus, discussion and conclusion. */
export async function readMacroRoom(db, { now = Date.now() } = {}) {
  await ensureThreadSchema(db);
  const row = await db.prepare("SELECT run_id FROM agent_thread_messages WHERE thread_id = ? AND step = 'conclusion' AND status = 'ok' ORDER BY ts DESC LIMIT 1").bind(MACRO_THREAD).first()
    ?? await db.prepare("SELECT run_id FROM agent_thread_messages WHERE thread_id = ? AND step = 'brief' ORDER BY ts DESC LIMIT 1").bind(MACRO_THREAD).first();
  if (!row) return null;
  const msgs = ((await db.prepare("SELECT * FROM agent_thread_messages WHERE thread_id = ? AND run_id = ? ORDER BY id").bind(MACRO_THREAD, row.run_id).all()).results || []).map(rowToThreadMessage);
  const brief = msgs.find((m) => m.step === "brief");
  const c = msgs.find((m) => m.step === "conclusion");
  const at = brief?.at ?? String(row.run_id).split(":").slice(1).join(":");
  return {
    version: MACRO_ROOM_VERSION, run_id: row.run_id, kind: brief?.kind ?? String(row.run_id).split(":")[0], at,
    stale: Boolean(c?.ts && now - Date.parse(c.ts) > 8 * 3_600_000),
    roster: brief?.roster ?? [], calendar: brief?.calendar ?? null,
    openings: msgs.filter((m) => m.step.startsWith("open:")).map((m) => ({ id: m.id, agent: m.agent, name: macroAgentName(m.agent), status: m.status, bias: m.bias ?? null, confidence: m.confidence, claim: m.claim ?? null, model: m.model })),
    debate: msgs.filter((m) => m.step.startsWith("debate:")).map((m) => ({ id: m.id, agent: m.agent, name: macroAgentName(m.agent), status: m.status, bias: m.bias ?? null, confidence: m.confidence, rebuts: m.rebuts ?? [], argument: m.argument ?? null })),
    conclusion: c ? { status: c.status, bias: c.bias ?? null, confidence: c.confidence, summary: c.summary ?? null, reasons: c.reasons ?? [], drivers: (c.drivers ?? []).map(macroAgentName), horizon: c.horizon ?? null, ts: c.ts } : null
  };
}

/** What the rooms' News Analyst reads: the latest macro conclusion within 8 hours, or null. */
export async function macroDeskEvidence(db, { now = Date.now() } = {}) {
  try {
    const m = await readMacroRoom(db, { now });
    if (!m || m.stale || m.conclusion?.status !== "ok") return null;
    return { macro_bias: m.conclusion.bias, confidence: m.conclusion.confidence, summary: m.conclusion.summary, horizon: m.conclusion.horizon, session: m.kind === "event" ? "after a high-impact US event" : "after a 4-hour close" };
  } catch { return null; }
}
