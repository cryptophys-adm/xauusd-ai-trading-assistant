// The limit entry's council (docs/RFC_OMEGA_LIMIT_ENTRY.md §2-§4, stage 3; owner 2026-11-20). The async half of live
// limit entries: Omega's planner (src/omega-engine.mjs planIntents) is pure and never calls a model. As with the
// Position Manager (src/position-manager.mjs), the council runs in the main Worker's 5-minute ledger step, stores its
// answer in D1, and the next bridge sync hands the stored answer to planIntents, which checks it again against the live
// price:
//   entry    a signal whose gates passed under entry_order "limit" or "council" is filed by the sync (kind 'entry',
//            status 'asked'); the council (Omega's entry seat and the Position Manager's seat, one model call, meter
//            "entry_council") answers place or skip ("limit"), or enter_market, place_limit or skip ("council"), from
//            the 15m decision with its reasons and the 1H, 4H and 1D rooms' latest readings and biases. Under "council"
//            each answer needs a measured reason that holds (the rule of cut_loss, #488); one that does not is today's
//            market entry. Status 'answered' or 'silent' (a failure, a timeout, the daily cap).
//   pending  at each 15m close while an Omega limit rests (kind 'pending', once per order and 15m bar): keep, move (to
//            one of the broker key levels it is shown) or cancel, and under "council" convert to market. A move or
//            cancel needs a measured reason: the decision against the order's side, the agent's confidence trend a
//            drop, or price more than move_max_atr x ATR(14) of the 15m bars from the order; without one the order is
//            kept (keep_no_reason). A silent council cancels the order at that close (council_unavailable).
// The spend shares the Position Manager's daily cap (POSITION_COUNCIL_DAILY_USD, RFC §11). Prices stay in D1 and the
// model's messages; nothing here reaches Aether or the platform.
import { callBusModel } from "./model-call.mjs";
import { confidenceTrend } from "./agent-confidence.mjs";
import { atr } from "./strategy-engine.mjs";
import { omegaPendingOrders, brokerKeyLevels } from "./omega-engine.mjs";
import { limitKnobs } from "./omega-limit-knobs.mjs";
import { recordLensReading } from "./lens-policy.mjs";

export const ENTRY_COUNCIL_METER = "entry_council";
/** A stored pending action older than this is not applied (as the Position Manager's ACTION_TTL_MS). */
export const LIMIT_ACTION_TTL_MS = 6 * 60_000;
/** An entry request is answered while its signal can still enter (max_signal_age_ms is at most 60 minutes). */
export const ENTRY_REQUEST_TTL_MS = 15 * 60_000;
/** The quorum's share on the side that fell by more than this since the bar before is a measured drop (the PM's). */
export const ENTRY_SHARE_DROP = 0.05;
/** A level at least this many plan stops away from price is a real pullback for a resting limit. */
export const PULLBACK_MIN_R = 0.1;
const M15 = 15 * 60_000;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const parse = (t, d = null) => { try { return t == null ? d : typeof t === "string" ? JSON.parse(t) : t; } catch { return d; } };

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS limit_council (id TEXT PRIMARY KEY, kind TEXT NOT NULL, open_id TEXT, ticket INTEGER, bar INTEGER, at_ms INTEGER NOT NULL,
    status TEXT NOT NULL, choice TEXT, rule TEXT, price REAL, max_move REAL, reason TEXT, council TEXT, facts TEXT, updated_ms INTEGER)`,
  "CREATE INDEX IF NOT EXISTS limit_council_status ON limit_council (kind, status, at_ms)",
  "CREATE INDEX IF NOT EXISTS limit_council_ticket ON limit_council (ticket, at_ms)"
];
let ready = null;
export async function ensureLimitCouncilSchema(db) {
  if (ready === db) return;
  for (const q of SCHEMA_SQL) await db.prepare(q).run();
  ready = db;
}
export function resetLimitCouncilSchemaForTests() { ready = null; }

// ---------------------------------------------------------------------------------------------------- the entry

/** The measured reasons the entry council may give, and the answers each supports (RFC §2). */
export const ENTRY_REASONS = Object.freeze({
  htf_against: "skip", confidence_drop: "skip", quorum_share_drop: "skip",
  price_away_from_level: "place_limit",
  price_at_level: "enter_market", htf_with: "enter_market", confidence_rising: "enter_market",
  // The liquidity lens (docs/RFC_POSITIONING_LIQUIDITY.md §5.3): thin liquidity rests as a maker; a reclaimed sweep
  // for the side enters now; one against it skips. Each holds only while the lens is on (the request carries it).
  liquidity_thin: "place_limit", liquidity_sweep_with: "enter_market", liquidity_sweep_against: "skip"
});
export function entryCouncilSchema(entryOrder) {
  const answers = entryOrder === "council" ? ["enter_market", "place_limit", "skip"] : ["place", "skip"];
  return Object.freeze({
    type: "object", additionalProperties: false, required: ["answer", "measured", "reason"],
    properties: {
      answer: { type: "string", enum: answers },
      measured: { type: "array", maxItems: 4, items: { type: "string", enum: Object.keys(ENTRY_REASONS) } },
      reason: { type: "string", maxLength: 240 }
    }
  });
}

/**
 * Pure: what the entry council reads. `request` is planIntents' entry_request, `decision` the latest Decision Engine
 * record (stance, confidence, summary, reasons, quorum with quorum_prev, agent confidence now and 15 minutes before),
 * `rooms` the 1H, 4H and 1D rooms' latest readings ({ room, bias, at, reasons }).
 */
export function entryFacts({ request, decision = null, rooms = [] }) {
  const buy = request.side === "BUY", k = buy ? "long" : "short";
  const agent = request.agent || "zone_pullback";
  const conf = decision?.agent_confidence?.[agent]?.[k], prev = decision?.agent_confidence_prev?.[agent]?.[k];
  const share = buy ? decision?.quorum?.long_share : decision?.quorum?.short_share;
  const sharePrev = buy ? decision?.quorum_prev?.long_share : decision?.quorum_prev?.short_share;
  const against = buy ? "BEARISH" : "BULLISH", withSide = buy ? "BULLISH" : "BEARISH";
  const htf = rooms.map((r) => ({ room: r.room, bias: String(r.bias ?? "").toUpperCase() || null, at: r.at ?? null, reasons: (r.reasons ?? []).slice(0, 3) }));
  return {
    side: request.side, entry_order: request.entry_order, mode: request.mode ?? null, agent, action: request.action ?? null,
    plan: request.plan ?? null, market: request.market ?? null, limit: request.limit ?? null,
    decision: decision ? { stance: decision.stance ?? null, confidence: isNum(decision.confidence) ? decision.confidence : null, summary: String(decision.summary ?? "").slice(0, 400), reasons: (Array.isArray(decision.reasons) ? decision.reasons : []).slice(0, 5).map((x) => String(x).slice(0, 240)) } : null,
    measured: {
      agent_confidence_now: isNum(conf) ? conf : null, agent_confidence_15m_ago: isNum(prev) ? prev : null, agent_trend: confidenceTrend(conf, prev),
      quorum_share_with_side: isNum(share) ? share : null, quorum_share_15m_ago: isNum(sharePrev) ? sharePrev : null
    },
    htf,
    ...(request.liquidity ? { liquidity: { weight: request.liquidity.weight ?? null, thin: request.liquidity.thin === true, sweep: request.liquidity.sweep ?? null } } : {}),
    holds: {
      // The liquidity lens's reasons hold only while it is on (the request carries it); off, the facts are today's.
      ...(request.liquidity ? { liquidity_thin: request.liquidity.thin === true, liquidity_sweep_with: request.liquidity.sweep === "with", liquidity_sweep_against: request.liquidity.sweep === "against" } : {}),
      htf_against: htf.some((r) => r.bias === against),
      htf_with: htf.some((r) => r.bias === withSide) && !htf.some((r) => r.bias === against),
      confidence_drop: confidenceTrend(conf, prev) === "drop",
      confidence_rising: confidenceTrend(conf, prev) === "rising",
      quorum_share_drop: isNum(share) && isNum(sharePrev) && sharePrev - share > ENTRY_SHARE_DROP,
      price_away_from_level: request.limit?.price != null && isNum(request.limit?.away_r) && request.limit.away_r >= PULLBACK_MIN_R,
      price_at_level: request.limit?.refused === "limit_through_price" || (isNum(request.limit?.away_r) && request.limit.away_r < PULLBACK_MIN_R)
    }
  };
}

export function entryCouncilMessages(f) {
  const three = f.entry_order === "council";
  const ask = three
    ? "Answer enter_market (take the market price now), place_limit (rest a limit at the plan's level and wait for price) or skip (no entry), with the measured reasons that support it: htf_against, confidence_drop or quorum_share_drop for skip; price_away_from_level for place_limit; price_at_level, htf_with or confidence_rising for enter_market. An answer without a measured reason that holds becomes the market entry."
    : "Answer place (rest a limit at the plan's level) or skip (no order: a missed limit is a missed trade), with the measured reasons you used.";
  // The liquidity lens, only while it is on (RFC §5.3): the broker's own tick volume, weighed at the lens weight.
  const liq = f.liquidity ? ` liquidity is the broker's own tick volume, weighed at ${f.liquidity.weight ?? "its lens weight"}: liquidity_thin (thin liquidity) supports ${three ? "place_limit" : "place"}, liquidity_sweep_with (a reclaimed sweep for this side in the last 15 minutes) supports ${three ? "enter_market" : "place"}, liquidity_sweep_against supports skip.` : "";
  const evidence = { side: f.side, mode: f.mode, plan: f.plan, market: f.market, limit: f.limit, decision: f.decision, measured: f.measured, higher_timeframes: f.htf, ...(f.liquidity ? { liquidity: f.liquidity } : {}) };
  return [
    { role: "system", content: `You are the Entry Council of the XAUUSD system: Omega's entry seat and the Position Manager's seat, in one answer. Every gate of the system has already passed for this 15m signal; you decide only how it enters, from measured inputs: the 15m decision with its reasons, the strategy agent's confidence on the side now and 15 minutes ago, the quorum's share on the side, and the 1H, 4H and 1D rooms' latest readings and biases. A WAIT or neutral reading alone is never a reason. ${ask}${liq} You never choose a size or a price. Return only the JSON object, with one short reason in plain words.` },
    { role: "user", content: JSON.stringify(evidence) }
  ];
}

export function cleanEntryCouncil(o, entryOrder) {
  const answers = entryOrder === "council" ? ["enter_market", "place_limit", "skip"] : ["place", "skip"];
  if (!o || !answers.includes(o.answer)) return null;
  const measured = [...new Set((Array.isArray(o.measured) ? o.measured : []).filter((x) => Object.hasOwn(ENTRY_REASONS, x)))].slice(0, 4);
  return { answer: o.answer, measured, reason: String(o.reason ?? "").slice(0, 240) };
}

/**
 * Pure: the stored outcome of the entry council: { status: "answered" | "silent", choice, rule, reason }. "limit":
 * place -> place_limit, skip -> skip. "council": the answer stands only with a measured reason for it that holds in the
 * facts; otherwise it is today's market entry (rule no_measured_reason). No answer: silent (council_failed).
 */
export function entryChoice(f, council, { silentRule = "council_failed" } = {}) {
  if (!council) return { status: "silent", choice: null, rule: silentRule, reason: null };
  if (f.entry_order !== "council") {
    const choice = council.answer === "place" ? "place_limit" : "skip";
    return { status: "answered", choice, rule: choice === "place_limit" ? "council_place" : "council_skip", reason: council.reason };
  }
  const held = council.measured.filter((m) => ENTRY_REASONS[m] === council.answer && f.holds[m] === true);
  if (!held.length) return { status: "answered", choice: "enter_market", rule: "no_measured_reason", reason: `${council.answer} without a measured reason that holds: the market entry; ${council.reason}`.slice(0, 240) };
  return { status: "answered", choice: council.answer, rule: held.join("+"), reason: council.reason };
}

// ---------------------------------------------------------------------------------------------------- while pending

export const PENDING_COUNCIL_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["answer", "move_to", "reason"],
  properties: {
    answer: { type: "string", enum: ["keep", "move", "cancel", "convert"] },
    move_to: { type: ["number", "null"] },
    reason: { type: "string", maxLength: 240 }
  }
});

/**
 * Pure: what the pending council reads of one resting Omega limit (`order` from the terminal's report, `meta` its
 * place_limit intent): the order, the current 15m decision against the placing one, the price, ATR(14) of the closed
 * 15m bars (`atr15`, a range: the same on the feed's and the broker's scale) and the broker key levels it may move to:
 * the near edges between the order and price, within move_max_atr x ATR of the order, with the broker's stop level.
 */
export function pendingFacts({ order, meta = {}, decision = null, sym = {}, atr15 = null, levels = [], now = Date.now() }) {
  const buy = order.type === "BUY_LIMIT", side = buy ? "BUY" : "SELL", k = buy ? "long" : "short";
  const knobs = meta?.knobs && isNum(meta.knobs.move_max_atr) ? meta.knobs : limitKnobs(meta?.mode);
  const level = Number(order.price_open), price = buy ? sym.ask : sym.bid;
  const agent = typeof meta?.strategy === "string" && meta.strategy ? meta.strategy : "zone_pullback";
  const conf = decision?.agent_confidence?.[agent]?.[k], prev = decision?.agent_confidence_prev?.[agent]?.[k];
  const share = buy ? decision?.quorum?.long_share : decision?.quorum?.short_share;
  const maxMove = isNum(atr15) && atr15 > 0 ? r2(knobs.move_max_atr * atr15) : null;
  const point = isNum(sym.point) && sym.point > 0 ? sym.point : 0.01;
  const minDist = (isNum(sym.stops_level_points) ? sym.stops_level_points : 0) * point;
  const candidates = maxMove == null || !isNum(price) ? [] : [...new Set(levels.map((z) => r2(buy ? z.low : z.high)))]
    .filter((x) => (buy ? x > level + point / 2 && x <= level + maxMove + 1e-9 && price - x > Math.max(minDist, point) : x < level - point / 2 && x >= level - maxMove - 1e-9 && x - price > Math.max(minDist, point)))
    .sort((a, b) => (buy ? a - b : b - a));
  const awayAtr = isNum(atr15) && atr15 > 0 && isNum(price) ? r3(Math.abs(price - level) / atr15) : null;
  const against = decision?.stance === (buy ? "SELL" : "BUY");
  return {
    ticket: order.ticket, side, level, sl: Number(order.sl) || null, tp: Number(order.tp) || null, lot: Number(order.volume_current ?? order.volume_initial) || null,
    placed_ms: Number(order.placed_ms) || Number(meta?.placed_ms) || null, age_min: Number(order.placed_ms) > 0 ? Math.round((now - Number(order.placed_ms)) / 60_000) : null,
    entry_order: meta?.entry_order ?? null, mode: knobs.mode ?? meta?.mode ?? null, agent, price: isNum(price) ? price : null, atr15: isNum(atr15) ? r2(atr15) : null, away_atr: awayAtr,
    move_max_atr: knobs.move_max_atr, max_move: maxMove, candidates,
    stance: decision?.stance ?? null, share: isNum(share) ? share : null, share0: isNum(meta?.share0) ? meta.share0 : null,
    agent_conf: isNum(conf) ? conf : null, agent_conf_prev: isNum(prev) ? prev : null, agent_trend: confidenceTrend(conf, prev),
    reasons: [
      ...(against ? [`the decision is ${decision.stance}`] : []),
      ...(confidenceTrend(conf, prev) === "drop" ? [`the ${agent} confidence dropped ${prev} to ${conf}`] : []),
      ...(awayAtr != null && awayAtr > knobs.move_max_atr + 1e-9 ? [`price is ${awayAtr} x ATR(14) 15m from the order, more than ${knobs.move_max_atr}`] : [])
    ]
  };
}

export function pendingCouncilMessages(f) {
  const evidence = {
    order: { side: f.side, level: f.level, stop: f.sl, target: f.tp, age_min: f.age_min, mode: f.mode },
    price: f.price, atr_15m: f.atr15, distance_in_atr: f.away_atr,
    measured: { decision_stance: f.stance, quorum_share_with_order: f.share, quorum_share_at_placement: f.share0, agent: f.agent, agent_confidence_now: f.agent_conf, agent_confidence_15m_ago: f.agent_conf_prev, agent_trend: f.agent_trend },
    move_to_levels: f.candidates, measured_reasons_that_hold: f.reasons
  };
  const convert = f.entry_order === "council" ? " Or convert: cancel it and enter at market instead (once per signal)." : "";
  return [
    { role: "system", content: `You are the Entry Council of the XAUUSD system, checking ONE resting limit order at a 15m close. Answer keep, move (to one of move_to_levels, only toward price; the stop and target move with it) or cancel.${convert} A move, cancel or convert needs one of the measured reasons that hold (the decision against the order's side, the strategy agent's confidence dropping, price far from the order); without one the order is kept. A WAIT stance alone is never a reason. You never choose a size. Return only the JSON object; move_to is the level for a move, else null.` },
    { role: "user", content: JSON.stringify(evidence) }
  ];
}

export function cleanPendingCouncil(o) {
  if (!o || !["keep", "move", "cancel", "convert"].includes(o.answer)) return null;
  return { answer: o.answer, move_to: isNum(o.move_to) ? o.move_to : null, reason: String(o.reason ?? "").slice(0, 240) };
}

/**
 * Pure: the action on one resting limit from its facts and the council's answer (null when it failed or the cap was
 * reached): { action: "keep" | "move" | "cancel" | "convert", rule, price?, max_move?, why }.
 */
export function pendingAction(f, council) {
  if (!council) return { action: "cancel", rule: "council_unavailable", why: "the council did not answer at this 15m close: the order is cancelled (no pending order is left unattended)" };
  if (council.answer === "keep") return { action: "keep", rule: "council_keep", why: council.reason };
  if (!f.reasons.length) return { action: "keep", rule: "keep_no_reason", why: `the council asked to ${council.answer}, with no measured reason: the order is kept` };
  if (council.answer === "convert" && f.entry_order !== "council") return { action: "keep", rule: "convert_needs_council_mode", why: "a conversion to market needs entry_order council" };
  if (council.answer === "move") {
    const to = council.move_to;
    const hit = isNum(to) ? f.candidates.find((x) => Math.abs(x - to) <= 0.005 + 1e-9) : undefined;
    if (hit === undefined) return { action: "keep", rule: "move_not_a_level", why: `a move to ${to ?? "no level"} is not one of the broker key levels toward price within ${f.move_max_atr} x ATR` };
    return { action: "move", rule: "council_move", price: hit, max_move: f.max_move, why: `${f.reasons.join("; ")}: the order moves to ${hit}; ${council.reason}`.slice(0, 400) };
  }
  return { action: council.answer, rule: council.answer === "convert" ? "council_convert" : "council_cancel", why: `${f.reasons.join("; ")}; ${council.reason}`.slice(0, 400) };
}

// ---------------------------------------------------------------------------------------------------- D1

/** Files an entry request (INSERT OR IGNORE: once per signal). Never throws. */
export async function requestEntryCouncil(db, request, { now = Date.now() } = {}) {
  if (!request?.id) return false;
  try {
    await ensureLimitCouncilSchema(db);
    const r = await db.prepare("INSERT OR IGNORE INTO limit_council (id, kind, open_id, at_ms, status, facts, updated_ms) VALUES (?, 'entry', ?, ?, 'asked', ?, ?)").bind(`ec:${request.id}`, request.id, now, JSON.stringify(request), now).run();
    return Number(r?.meta?.changes ?? 1) > 0;
  } catch { return false; }
}

/** The stored answer for this open id ({ id, status, choice, rule, reason }), or null while none. Never throws. */
export async function readEntryCouncil(db, openIdValue) {
  if (!openIdValue) return null;
  try {
    await ensureLimitCouncilSchema(db);
    const r = await db.prepare("SELECT open_id, status, choice, rule, reason FROM limit_council WHERE id = ?").bind(`ec:${openIdValue}`).first();
    if (!r || (r.status !== "answered" && r.status !== "silent")) return null;
    return { id: r.open_id, status: r.status, choice: r.choice ?? null, rule: r.rule ?? null, reason: r.reason ?? null };
  } catch { return null; }
}

/** The fresh pending actions the sync hands to planIntents (move, cancel, convert), newest per ticket. Never throws. */
export async function pendingLimitActions(db, { now = Date.now() } = {}) {
  try {
    await ensureLimitCouncilSchema(db);
    const rows = (await db.prepare("SELECT id, ticket, choice, rule, price, max_move, at_ms FROM limit_council WHERE kind = 'pending' AND status = 'pending' AND at_ms > ? ORDER BY at_ms DESC").bind(now - LIMIT_ACTION_TTL_MS).all()).results ?? [];
    const seen = new Set(), out = [];
    for (const r of rows) { if (seen.has(r.ticket)) continue; seen.add(r.ticket); out.push({ id: r.id, ticket: Number(r.ticket), action: r.choice, rule: r.rule, price: r.price == null ? null : Number(r.price), max_move: r.max_move == null ? null : Number(r.max_move), at_ms: r.at_ms }); }
    return out;
  } catch { return []; }
}
export async function markLimitActions(db, ids, status, { now = Date.now() } = {}) {
  for (const id of ids) { try { await db.prepare("UPDATE limit_council SET status = ?, updated_ms = ? WHERE id = ? AND status = 'pending'").bind(status, now, id).run(); } catch { /* the TTL expires it */ } }
}

/** The 1H, 4H and 1D rooms' latest concluded readings ({ room, bias, at, reasons }). Never throws. */
export async function htfRoomReadings(db) {
  const out = [];
  for (const [room, label] of [["tf:H1", "1H"], ["tf:H4", "4H"], ["tf:D1", "1D"]]) {
    try {
      const r = await db.prepare("SELECT bar_close, bias, body_json FROM room_runs WHERE room = ? AND status = 'concluded' ORDER BY bar_close DESC LIMIT 1").bind(room).first();
      if (!r) continue;
      const c = parse(r.body_json, {})?.conclusion ?? {};
      out.push({ room: label, bias: String(r.bias ?? c.bias ?? "").toUpperCase() || null, at: r.bar_close ?? null, reasons: (Array.isArray(c.reasons) ? c.reasons : []).slice(0, 3).map((x) => String(x).slice(0, 200)) });
    } catch { /* that room has no reading */ }
  }
  return out;
}

/** ATR(14) of the closed 15m bars (strategy-engine atr) from the feed's 15m series, or null. Never throws. */
export async function atr15m(env, { now = Date.now() } = {}) {
  try {
    const rec = JSON.parse((await env.SIGNAL_CACHE?.get?.("market-data:v2:series:OANDA:XAUUSD|15m")) || "null");
    const closed = (Array.isArray(rec?.candles) ? rec.candles : []).filter((c) => Date.parse(String(c?.close_time ?? "")) <= now).sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time));
    const a = atr(closed.slice(-15), 14);
    return isNum(a) && a > 0 ? a : null;
  } catch { return null; }
}

/** The place_limit intents of these ids (an order's comment, a position's intent id) or order tickets ([{ id, payload, result, status }]). */
export async function placeLimitRows(db, { ids = [], tickets = [] } = {}) {
  const idList = [...new Set(ids.filter((x) => typeof x === "string" && x))].slice(0, 50);
  const tList = [...new Set(tickets.map(Number).filter((t) => t > 0))].slice(0, 50);
  if (!idList.length && !tList.length) return [];
  const where = [idList.length ? `id IN (${idList.map(() => "?").join(", ")})` : null, tList.length ? `json_extract(result, '$.ticket') IN (${tList.map(() => "?").join(", ")})` : null].filter(Boolean).join(" OR ");
  try {
    const rows = (await db.prepare(`SELECT id, payload, result, status FROM omega_intents WHERE kind = 'place_limit' AND (${where})`).bind(...idList, ...tList).all()).results ?? [];
    return rows.map((r) => ({ id: r.id, payload: parse(r.payload, {}), result: parse(r.result, null), status: r.status }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------------------------------- the runner

/**
 * The runner, in the 5-minute ledger step after the Position Manager: the entry requests filed by the syncs, then each
 * resting Omega limit once per 15m close. Off while entry_order is "market". `deps` let the tests give the settings, the
 * executor, the decision, the rooms, ATR and the model call. Never throws.
 */
export async function runLimitCouncil(env, { now = Date.now(), call = callBusModel, settings: settingsIn, executor: executorIn, decision: decisionIn, rooms: roomsIn, atr: atrIn, signal: signalIn, capUsd = null } = {}) {
  const db = env?.DB;
  if (!db) return { status: "unavailable" };
  try {
    let settings = settingsIn;
    if (settings === undefined) { try { settings = parse((await db.prepare("SELECT settings FROM omega_settings WHERE id = 1").first())?.settings, {}); } catch { settings = {}; } }
    const entryOrder = settings?.entry_order === "limit" || settings?.entry_order === "council" ? settings.entry_order : "market";
    if (entryOrder === "market") return { status: "off" };
    await ensureLimitCouncilSchema(db);
    const pm = await import("./position-manager.mjs");
    const cap = isNum(capUsd) ? capUsd : pm.dailyCapUsd(env);
    let spent = await pm.positionCouncilSpendUsd(db, { now });
    const decision = decisionIn !== undefined ? decisionIn : await pm.latestDecisions(db);
    // One AI task (organism.json "entry_council"): the entry and the pending check, each with its own schema.
    const ask = async (messages, schema) => {
      if (spent >= cap) return { obj: null, rule: "daily_cap" };
      try {
        const r = await call(env, { messages, schemaName: "entry_council", schema, maxTokens: 400, effort: "low", deadline: Date.now() + 45_000, clock: () => Date.now(), runState: {}, role: "agent", meterSource: ENTRY_COUNCIL_METER });
        spent = await pm.positionCouncilSpendUsd(db, { now }).catch(() => spent);
        return { obj: r?.status === "answered" ? r.obj : null, rule: "council_failed" };
      } catch { return { obj: null, rule: "council_failed" }; }
    };
    const out = { status: "ran", entries: [], pending: [] };

    // The entry requests the syncs filed.
    const asked = (await db.prepare("SELECT id, open_id, facts FROM limit_council WHERE kind = 'entry' AND status = 'asked' AND at_ms > ? ORDER BY at_ms LIMIT 3").bind(now - ENTRY_REQUEST_TTL_MS).all()).results ?? [];
    let rooms = null;
    for (const row of asked) {
      const request = parse(row.facts, null);
      if (!request) continue;
      rooms ??= roomsIn !== undefined ? roomsIn : await htfRoomReadings(db);
      const f = entryFacts({ request: { ...request, entry_order: entryOrder }, decision, rooms });
      const a = await ask(entryCouncilMessages(f), entryCouncilSchema(entryOrder));
      const council = a.obj ? cleanEntryCouncil(a.obj, entryOrder) : null;
      const c = entryChoice(f, council, { silentRule: a.rule });
      await db.prepare("UPDATE limit_council SET status = ?, choice = ?, rule = ?, reason = ?, council = ?, updated_ms = ? WHERE id = ? AND status = 'asked'")
        .bind(c.status, c.choice, c.rule, c.reason, council ? JSON.stringify(council) : null, now, row.id).run();
      out.entries.push({ id: row.open_id, status: c.status, choice: c.choice, rule: c.rule });
      // The liquidity lens's maker reading (RFC §7.2): a liquidity_thin answer, scored later from the limit ledger's pair.
      if (String(c.rule ?? "").split("+").includes("liquidity_thin") && Number.isFinite(Number(request.issued_ms))) {
        try { await recordLensReading(db, { id: `maker:${request.issued_ms}:${request.side === "BUY" ? "B" : "S"}`, lens: "liquidity", kind: "maker", at_ms: Number(request.issued_ms), mode: request.mode ?? null, side: request.side === "BUY" ? 1 : -1 }, { now }); } catch { /* the choice stands */ }
      }
    }

    // Each resting Omega limit at the 15m close (once per order and bar, only for an order placed before that close).
    const executor = executorIn !== undefined ? executorIn : parse((await db.prepare("SELECT state FROM omega_bridge WHERE id = 1").first())?.state, null);
    const orders = omegaPendingOrders(executor);
    const close = Math.floor(now / M15) * M15;
    // The decision of that close, or what there is ten minutes after it.
    const decisionClose = Date.parse(String(decision?.bar_close ?? ""));
    const fresh = Number.isFinite(decisionClose) && decisionClose >= close;
    if (orders.length && (fresh || now - close >= 10 * 60_000)) {
      const metaRows = await placeLimitRows(db, { ids: orders.map((o) => o.comment), tickets: orders.map((o) => o.ticket) });
      const metaOf = (o) => (metaRows.find((r) => r.id === o.comment || Number(r.result?.ticket) === Number(o.ticket))?.payload ?? {});
      let signal = signalIn;
      if (signal === undefined) { try { signal = await (await import("./ea-signal.mjs")).eaSignal(env, { now }); } catch { signal = null; } }
      const levels = brokerKeyLevels(signal) ?? [];
      const atr15 = atrIn !== undefined ? atrIn : await atr15m(env, { now });
      for (const o of orders) {
        if (!(Number(o.placed_ms) > 0) || Number(o.placed_ms) >= close) continue;
        const id = `lc:${o.ticket}:${Math.floor(close / 60_000)}`;
        if (await db.prepare("SELECT id FROM limit_council WHERE id = ?").bind(id).first()) continue;
        const meta = metaOf(o);
        const f = pendingFacts({ order: o, meta: { ...meta, entry_order: entryOrder }, decision, sym: executor?.symbol ?? {}, atr15, levels, now });
        const a = await ask(pendingCouncilMessages(f), PENDING_COUNCIL_SCHEMA);
        const council = a.obj ? cleanPendingCouncil(a.obj) : null;
        const act = pendingAction(f, council);
        const status = act.action === "keep" ? "noted" : "pending";
        await db.prepare("INSERT OR IGNORE INTO limit_council (id, kind, open_id, ticket, bar, at_ms, status, choice, rule, price, max_move, reason, council, facts, updated_ms) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, o.comment ?? null, o.ticket, Math.floor(close / 60_000), now, status, act.action, act.rule, act.price ?? null, act.max_move ?? null, council ? act.why : `${act.why} (${a.rule})`, council ? JSON.stringify(council) : null, JSON.stringify({ reasons: f.reasons, away_atr: f.away_atr, candidates: f.candidates }), now).run();
        out.pending.push({ ticket: o.ticket, action: act.action, rule: act.rule });
      }
    }
    return { ...out, spent_usd: spent, cap_usd: cap };
  } catch (error) {
    return { status: "failed", error: String(error?.message ?? error).slice(0, 160) };
  }
}
